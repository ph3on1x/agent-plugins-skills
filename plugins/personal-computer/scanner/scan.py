#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "mlx==0.32.4",
#   "mlx-lm==0.32.2",
#   "mlx-embeddings @ git+https://github.com/Blaizzy/mlx-embeddings@9b28270be81211f2b8daed0041aec65ea5dc4b28",
#   "numpy",
#   "tokenizers",
#   "huggingface_hub",
#   "pypdf",
# ]
# ///
"""personal-computer's PII scanner: OpenAI Privacy Filter and PII-Tracer on MLX behind a loopback HTTP endpoint.

usage: scan.py --state <file> [--idle <seconds>] [--models opf,pii-tracer]
       scan.py --download [--models opf,pii-tracer]   fetch the models, one JSON line per step, and exit
  POST /scan {"text": "...", "models": [...]} -> {"spans": [{"type", "start", "end", "score", "model"}], "ms"}
  POST /scan {"path": "x.pdf", ...} -> the same over the PDF's text, plus "text": what Claude's Read would show of it
  GET /health -> {"ok": true, "models": [the loaded ones]}
--models are loaded at the start; a request for another loads it then (sessions may choose differently).
Spans are unfiltered: the mod applies the thresholds (hooks/pii.js). One scanner serves every session: a lock beside
the state file makes a second start exit at once, and the scanner exits after --idle seconds without a request.
"""
import argparse, fcntl, json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_embeddings.utils import load as load_embeddings
from mlx_lm.models import qwen3
from tokenizers import Tokenizer

OPF_REPO = "mlx-community/openai-privacy-filter-bf16"
TRACER_REPO = "perplexity-ai/PII-Tracer"
TRACER_FILES = ["config.json", "model.safetensors", "tokenizer.json"]
TRACER_TYPES = ["private_person", "private_email", "private_phone", "private_address", "private_url", "private_date",
                "account_number", "secret", "other_pii"]


# Constrained BIOES decoding, shared by both models (both tag tokens O / B- / I- / E- / S-<type>).
def bioes_tables(labels):
    n = len(labels); idx = {l: i for i, l in enumerate(labels)}
    types = sorted({l[2:] for l in labels if l != "O"})
    trans = np.full((n, n), -np.inf, dtype=np.float32)
    ends = {idx["O"]} | {idx[f"{t}-{p}"] for p in types for t in "ES"}
    begins = {idx["O"]} | {idx[f"{t}-{p}"] for p in types for t in "BS"}
    for p in types:
        b, i, e = idx[f"B-{p}"], idx[f"I-{p}"], idx[f"E-{p}"]
        trans[b, i] = trans[b, e] = trans[i, i] = trans[i, e] = 0.0
    for f in ends:
        for t in begins:
            trans[f, t] = 0.0
    start = np.array([0.0 if (l == "O" or l[0] in "BS") else -np.inf for l in labels], dtype=np.float32)
    end = np.array([0.0 if (l == "O" or l[0] in "ES") else -np.inf for l in labels], dtype=np.float32)
    return trans, start, end


def viterbi(logp, tables):
    trans, start, end = tables
    v = logp[0] + start; bp = np.empty((max(logp.shape[0] - 1, 0), logp.shape[1]), dtype=np.int32)
    for t in range(1, logp.shape[0]):
        s = v[:, None] + trans
        bp[t - 1] = s.argmax(0); v = logp[t] + s.max(0)
    path = [int((v + end).argmax())]
    for t in range(logp.shape[0] - 2, -1, -1):
        path.append(int(bp[t, path[-1]]))
    return path[::-1]


def decode(path, probs, labels, offsets):
    """[(type, start, end, mean prob)] in character offsets."""
    out, t = [], 0
    while t < len(path):
        l = labels[path[t]]
        if l[0] == "S":
            out.append((l[2:], offsets[t][0], offsets[t][1], float(probs[t, path[t]]))); t += 1
        elif l[0] == "B":
            p, a, b, ps = l[2:], offsets[t][0], offsets[t][1], [probs[t, path[t]]]; t += 1
            while t < len(path) and labels[path[t]] in (f"I-{p}", f"E-{p}"):
                b = offsets[t][1]; ps.append(probs[t, path[t]]); last = labels[path[t]][0]; t += 1
                if last == "E":
                    break
            out.append((p, a, b, float(np.mean(ps))))
        else:
            t += 1
    return out


def log_softmax(x):
    x = x - x.max(-1, keepdims=True)
    return x - np.log(np.exp(x).sum(-1, keepdims=True))


def windows(n, size, stride):
    """Token windows of one length (the last aligned to the end), so they batch."""
    if n <= size:
        return [(0, n)]
    return [(a, a + size) for a in list(range(0, n - size, stride)) + [n - size]]


def spans_of(text, wins, logits, labels, tables, offsets, model):
    out = []
    for (a, b), lg in zip(wins, logits):
        lp = log_softmax(lg)
        for typ, s, e, p in decode(viterbi(lp, tables), np.exp(lp), labels, offsets[a:b]):
            while s < e and text[s].isspace(): s += 1
            while e > s and text[e - 1].isspace(): e -= 1
            if s < e:
                out.append({"type": typ, "start": s, "end": e, "score": round(p, 4), "model": model})
    return out


class Opf:
    # One pass is fastest on MLX (10-15 ms per 1k tokens); 8k windows bound memory on long outputs.
    def __init__(self):
        self.model, _ = load_embeddings(OPF_REPO)
        root = snapshot_download(OPF_REPO)
        cfg = json.load(open(f"{root}/config.json"))
        self.labels = [cfg["id2label"][str(i)] for i in range(len(cfg["id2label"]))]
        self.tables = bioes_tables(self.labels)
        self.tok = Tokenizer.from_file(f"{root}/tokenizer.json"); self.tok.no_truncation()

    def scan(self, text):
        e = self.tok.encode(text, add_special_tokens=False)
        wins = windows(len(e.ids), 8192, 7168)
        logits = []
        for a, b in wins:
            x = mx.array([e.ids[a:b]])
            lg = self.model(x, attention_mask=mx.ones_like(x)).logits[0].astype(mx.float32)
            mx.eval(lg); logits.append(np.array(lg))
        return spans_of(text, wins, logits, self.labels, self.tables, e.offsets, "opf")


class Tracer:
    # PII-Tracer is a bidirectional Qwen3 encoder: mlx-lm's Qwen3 with the causal mask removed, plus its token head.
    # 1024-token windows at stride 768, batched, found every span the 4096 windows did, faster (p3).
    def __init__(self):
        root = Path(snapshot_download(TRACER_REPO, allow_patterns=TRACER_FILES))
        cfg = json.load(open(root / "config.json"))["backbone"]
        qwen3.create_attention_mask = lambda h, cache=None, **k: None
        args = qwen3.ModelArgs(model_type="qwen3", hidden_size=cfg["hidden_size"], num_hidden_layers=cfg["num_hidden_layers"],
            intermediate_size=cfg["intermediate_size"], num_attention_heads=cfg["num_attention_heads"], rms_norm_eps=cfg["rms_norm_eps"],
            vocab_size=cfg["vocab_size"], num_key_value_heads=cfg["num_key_value_heads"], max_position_embeddings=cfg["max_position_embeddings"],
            rope_theta=cfg["rope_parameters"]["rope_theta"], head_dim=cfg["head_dim"], tie_word_embeddings=True)
        self.enc = qwen3.Qwen3Model(args)
        w = mx.load(str(root / "model.safetensors"))
        self.enc.load_weights([(k[9:], v) for k, v in w.items() if k.startswith("backbone.")], strict=True)
        self.W, self.b = w["token_cls_head.weight"].astype(mx.float32), w["token_cls_head.bias"].astype(mx.float32)
        mx.eval(self.enc.parameters())
        self.labels = ["O"] + [f"{t}-{p}" for p in TRACER_TYPES for t in "BIES"]
        self.tables = bioes_tables(self.labels)
        self.tok = Tokenizer.from_file(str(root / "tokenizer.json")); self.tok.no_truncation()

    def scan(self, text):
        e = self.tok.encode(text, add_special_tokens=False)
        wins = windows(len(e.ids), 1024, 768)
        logits = []
        for i in range(0, len(wins), 16):
            group = wins[i:i + 16]
            h = self.enc(mx.array([e.ids[a:b] for a, b in group])).astype(mx.float32)
            lg = h @ self.W.T + self.b
            mx.eval(lg); logits += list(np.array(lg))
        return spans_of(text, wins, logits, self.labels, self.tables, e.offsets, "pii-tracer")


def pdf_text(path):
    """The text layer of a PDF, page by page. A scanned page has none: OCR is not done here."""
    from pypdf import PdfReader
    return "\n\n".join(page.extract_text() or "" for page in PdfReader(path).pages)


MODELS = {"opf": Opf, "pii-tracer": Tracer}
DOWNLOADS = {"opf": (OPF_REPO, None), "pii-tracer": (TRACER_REPO, TRACER_FILES)}


def download(names):
    """Fetches each model into the Hugging Face cache, saying so as it goes."""
    for n in names:
        print(json.dumps({"model": n, "status": "downloading"}), flush=True)
        repo, files = DOWNLOADS[n]
        snapshot_download(repo, allow_patterns=files)
        print(json.dumps({"model": n, "status": "done"}), flush=True)


def load(name):
    m = MODELS[name]()
    m.scan("warm up")
    return m


def serve(state, idle, names):
    lock = open(f"{state}.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return  # another scanner is starting or running
    loaded = {n: load(n) for n in names}
    last = [time.monotonic()]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

        def do_GET(self):
            last[0] = time.monotonic()
            self.reply(200, {"ok": True, "models": list(loaded)}) if self.path == "/health" else self.reply(404, {"error": "not found"})

        def do_POST(self):
            last[0] = time.monotonic()
            if self.path != "/scan":
                return self.reply(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                wanted = body.get("models", list(loaded))
                unknown = [n for n in wanted if n not in MODELS]
                if unknown or not wanted:
                    return self.reply(400, {"error": f"models must be some of {list(MODELS)}, not {wanted}"})
                for n in wanted:
                    if n not in loaded:
                        loaded[n] = load(n)
                text = pdf_text(body["path"]) if "path" in body else body["text"]
                a = time.perf_counter()
                spans = [s for n in wanted for s in loaded[n].scan(text)]
                self.reply(200, {"spans": spans, "ms": round((time.perf_counter() - a) * 1000, 1), **({"text": text} if "path" in body else {})})
            except Exception as err:
                self.reply(500, {"error": f"{type(err).__name__}: {err}"})

    # Single-threaded on purpose: MLX evaluation is not safe across threads, so requests take turns.
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 5
    tmp = f"{state}.{os.getpid()}"
    Path(tmp).write_text(json.dumps({"port": server.server_address[1], "pid": os.getpid()}))
    os.replace(tmp, state)
    try:
        while time.monotonic() - last[0] < idle:
            server.handle_request()
    finally:
        try:
            if json.loads(Path(state).read_text()).get("pid") == os.getpid():
                os.remove(state)
        except (OSError, ValueError):
            pass


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--state")
    p.add_argument("--idle", type=float, default=1800)
    p.add_argument("--models", default="opf,pii-tracer")
    p.add_argument("--download", action="store_true")
    a = p.parse_args()
    names = a.models.split(",")
    if any(n not in MODELS for n in names):
        p.error(f"--models: some of {','.join(MODELS)}")
    if a.download:
        download(names)
    elif a.state is None:
        p.error("--state is required to serve")
    else:
        Path(a.state).parent.mkdir(parents=True, exist_ok=True)
        serve(a.state, a.idle, names)
    sys.exit(0)
