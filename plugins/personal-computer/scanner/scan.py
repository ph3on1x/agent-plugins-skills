#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#   "mlx==0.32.4; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "mlx-lm==0.32.2; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "mlx-embeddings @ git+https://github.com/Blaizzy/mlx-embeddings@9b28270be81211f2b8daed0041aec65ea5dc4b28 ; sys_platform == 'darwin' and platform_machine == 'arm64'",
#   "onnxruntime==1.31.1",
#   "numpy",
#   "tokenizers",
#   "huggingface_hub",
#   "pypdf",
#   "safetensors",
# ]
# ///
"""personal-computer's PII scanner: OpenAI Privacy Filter and PII-Tracer behind a loopback HTTP endpoint, on MLX
(Apple silicon) or ONNX Runtime (anywhere), as artifacts.js lists them.

usage: scan.py --state <file> [--idle <seconds>] [--models opf,pii-tracer] [--runtime mlx|onnx|onnx-int8|gguf]
       scan.py --download [--models opf,pii-tracer] [--runtime ...]   fetch the models, one JSON line per step
       scan.py --spans [--models opf,pii-tracer] [--runtime ...] < texts.json   print each text's spans as JSON
  POST /scan {"text": "...", "models": [...], "runtime": "mlx"} -> {"spans": [{"type", "start", "end", "score", "model"}], "ms"}
  POST /scan {"path": "x.pdf", ...} -> the same over the PDF's text, plus "text": what Claude's Read would show of it
  GET /health -> {"ok": true, "models": [the loaded ones, as model:runtime]}
--models are loaded at the start; a request for another model or runtime loads it then (sessions may choose
differently). Runtime gguf is PII-Tracer on the user's llama.cpp (llama-server on PATH), OpenAI Privacy Filter on ONNX
Runtime: it has no GGUF. MLX models live in the Hugging Face cache; the others in
$HF_HOME/personal-computer/<repo>@<revision>, as plain files: ONNX Runtime refuses external data behind the cache's
symlinks.
Spans are unfiltered: the mod applies the thresholds (hooks/pii.js). One scanner serves every session: a lock beside
the state file makes a second start exit at once, and the scanner exits after --idle seconds without a request.
"""
import argparse, atexit, fcntl, json, os, signal, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

# artifacts.js is JSON after "export default ": the mod imports it, and this reads it.
ARTIFACTS = json.loads(Path(__file__).with_name("artifacts.js").read_text().removeprefix("export default "))
# Hugging Face's home as huggingface_hub finds it (hooks/pc.js finds it alike): ONNX models are kept beside its hub.
MODELS_DIR = Path(os.environ.get("HF_HOME", os.path.join(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"), "huggingface"))) / "personal-computer"
OPF_WINDOW, TRACER_WINDOW = (8192, 7168), (1024, 768)
TRACER_TYPES = ["private_person", "private_email", "private_phone", "private_address", "private_url", "private_date",
                "account_number", "secret", "other_pii"]
TRACER_LABELS = ["O"] + [f"{t}-{p}" for p in TRACER_TYPES for t in "BIES"]


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


def opf_labels(root):
    cfg = json.load(open(root / "config.json"))
    return [cfg["id2label"][str(i)] for i in range(len(cfg["id2label"]))]


def tokenizer(path):
    tok = Tokenizer.from_file(str(path)); tok.no_truncation()
    return tok


def scan_windows(m, text):
    """A model's spans in a text: its windows' logits (m.logits), decoded alike for every runtime."""
    e = m.tok.encode(text, add_special_tokens=False)
    wins = windows(len(e.ids), *m.window)
    return spans_of(text, wins, m.logits(e.ids, wins), m.labels, m.tables, e.offsets, m.name)


class OpfMlx:
    # One pass is fastest on MLX (about 20 ms per 1k tokens); 8k windows bound memory on long outputs. It computes in
    # fp32: in bf16 it cut IBANs short where OpenAI's own fp32 inference does not (4 of 212 spans), in fp32 it agrees
    # span for span, at 1.6 times the time and 3 GB more memory.
    name, window = "opf", OPF_WINDOW

    def __init__(self, art):
        import mlx.core as mx
        from mlx.utils import tree_map
        from mlx_embeddings.utils import load as load_embeddings
        self.model, _ = load_embeddings(art["repo"])
        self.model.update(tree_map(lambda x: x.astype(mx.float32) if x.dtype == mx.bfloat16 else x, self.model.parameters()))
        mx.eval(self.model.parameters())
        root = Path(snapshot_download(art["repo"]))
        self.labels = opf_labels(root)
        self.tables = bioes_tables(self.labels)
        self.tok = tokenizer(root / "tokenizer.json")

    def logits(self, ids, wins):
        import mlx.core as mx
        out = []
        for a, b in wins:
            x = mx.array([ids[a:b]])
            lg = self.model(x, attention_mask=mx.ones_like(x)).logits[0].astype(mx.float32)
            mx.eval(lg); out.append(np.array(lg))
        return out


class TracerMlx:
    # PII-Tracer is a bidirectional Qwen3 encoder: mlx-lm's Qwen3 with the causal mask removed, plus its token head.
    # 1024-token windows at stride 768, batched, found every span the 4096 windows did, faster (p3).
    name, window = "pii-tracer", TRACER_WINDOW

    def __init__(self, art):
        import mlx.core as mx
        from mlx_lm.models import qwen3
        root = Path(snapshot_download(art["repo"], allow_patterns=art["files"]))
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
        self.labels = TRACER_LABELS
        self.tables = bioes_tables(self.labels)
        self.tok = tokenizer(root / "tokenizer.json")

    def logits(self, ids, wins):
        import mlx.core as mx
        out = []
        for i in range(0, len(wins), 16):
            group = wins[i:i + 16]
            h = self.enc(mx.array([ids[a:b] for a, b in group])).astype(mx.float32)
            lg = h @ self.W.T + self.b
            mx.eval(lg); out += list(np.array(lg))
        return out


class Onnx:
    """A published token-classification graph on ONNX Runtime's CPU: input_ids (and attention_mask, where the graph
    takes one) in, logits out, `batch` windows at a time."""

    def __init__(self, art, labels, batch):
        import onnxruntime as ort
        root = local_dir(art)
        absent = [f for f in art["files"] if not (root / f).is_file()]
        if absent:
            raise FileNotFoundError(f"{root} lacks {', '.join(absent)}: run /personal-computer setup")
        self.sess = ort.InferenceSession(str(root / art["graph"]), providers=["CPUExecutionProvider"])
        self.feeds = {i.name for i in self.sess.get_inputs()}
        n = next(o for o in self.sess.get_outputs() if o.name == "logits").shape[-1]
        if n != len(labels):
            raise ValueError(f"{art['repo']} gives {n} labels per token, not {len(labels)}")
        # A graph fixed at one batch size (maskmyai's, at 1) takes that many windows a run.
        fixed = next(i for i in self.sess.get_inputs() if i.name == "input_ids").shape[0]
        self.labels, self.tables, self.batch = labels, bioes_tables(labels), fixed if isinstance(fixed, int) else batch
        self.tok = tokenizer(root / art.get("tokenizer", "tokenizer.json"))

    def logits(self, ids, wins):
        out = []
        for i in range(0, len(wins), self.batch):
            x = np.array([ids[a:b] for a, b in wins[i:i + self.batch]], dtype=np.int64)
            feed = {"input_ids": x, **({"attention_mask": np.ones_like(x)} if "attention_mask" in self.feeds else {})}
            out += list(self.sess.run(["logits"], feed)[0].astype(np.float32))
        return out


class OpfOnnx(Onnx):
    # OpenAI's own ONNX export. Its attention is dense, so memory grows with the square of the window (about 21 GB
    # at 8192 tokens in fp32): one window at a time.
    name, window = "opf", OPF_WINDOW

    def __init__(self, art):
        super().__init__(art, opf_labels(local_dir(art)), batch=1)


class TracerOnnx(Onnx):
    # lemonade-sdk's ONNX export of PII-Tracer (its first name, pplx-pii-masking), fp32: the same spans as MLX. For
    # onnx-int8, maskmyai's 8-bit one: a quarter of the memory, and one of 225 spans fewer (test/parity).
    name, window = "pii-tracer", TRACER_WINDOW

    def __init__(self, art):
        super().__init__(art, TRACER_LABELS, batch=16)


class TracerGguf:
    # Perplexity's own GGUF of PII-Tracer on the user's llama-server: the backbone's hidden states per token from POST
    # /embeddings (pooling none), the token head from heads.safetensors applied here. Four windows a request, one per
    # server slot. The server is this scanner's child, stopped as it exits.
    name, window = "pii-tracer", TRACER_WINDOW

    def __init__(self, art):
        import shutil, socket, subprocess, tempfile
        from safetensors.numpy import load_file
        exe = shutil.which("llama-server")
        if exe is None:
            raise FileNotFoundError("llama-server is not on PATH: install llama.cpp (https://github.com/ggml-org/llama.cpp/releases)")
        root = local_dir(art)
        absent = [f for f in art["files"] if not (root / f).is_file()]
        if absent:
            raise FileNotFoundError(f"{root} lacks {', '.join(absent)}: run /personal-computer setup")
        if json.loads((root / "pii_head_config.json").read_text())["labels"] != TRACER_LABELS:
            raise ValueError(f"{art['repo']}'s head labels are not PII-Tracer's, in its order")
        heads = load_file(str(root / "heads.safetensors"))
        self.W, self.b = heads["token_cls_head.weight"].astype(np.float32), heads["token_cls_head.bias"].astype(np.float32)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        log = tempfile.TemporaryFile()
        proc = subprocess.Popen([exe, "-m", str(root / art["graph"]), "--host", "127.0.0.1", "--port", str(port), "--embeddings",
                                 "--pooling", "none", "-c", "4096", "-b", "4096", "-ub", "4096"], stdout=subprocess.DEVNULL, stderr=log)
        atexit.register(proc.terminate)
        deadline = time.monotonic() + 120
        while not self.healthy():
            if proc.poll() is not None or time.monotonic() > deadline:
                proc.terminate(); log.seek(0)
                tail = log.read().decode(errors="replace").strip().splitlines()[-3:]
                raise RuntimeError(f"llama-server did not start ({exe}): {' / '.join(tail) or 'no output'}")
            time.sleep(0.2)
        self.labels, self.tables = TRACER_LABELS, bioes_tables(TRACER_LABELS)
        self.tok = tokenizer(root / "tokenizer.json")
        # PII-Tracer reads in both directions, as its GGUF asks; a llama.cpp that runs it causally finds far less, with
        # no error. Changing the last token must move the first token's state.
        first, changed = self.hidden([[9707, 11, 1879, 0], [9707, 11, 1879, 1]])
        if np.abs(first[0] - changed[0]).max() < 1e-4:
            raise RuntimeError(f"{exe} runs PII-Tracer one-directional: it needs a llama.cpp that reads the GGUF's non-causal attention")

    def healthy(self):
        import urllib.request
        try:
            return json.loads(urllib.request.urlopen(f"{self.url}/health", timeout=2).read()).get("status") == "ok"
        except (OSError, ValueError):
            return False

    def hidden(self, seqs):
        import urllib.request
        req = urllib.request.Request(f"{self.url}/embeddings", data=json.dumps({"content": seqs}).encode(), headers={"Content-Type": "application/json"})
        return [np.asarray(x["embedding"], dtype=np.float32) for x in sorted(json.loads(urllib.request.urlopen(req, timeout=600).read()), key=lambda x: x["index"])]

    def logits(self, ids, wins):
        out = []
        for i in range(0, len(wins), 4):
            out += [h @ self.W.T + self.b for h in self.hidden([ids[a:b] for a, b in wins[i:i + 4]])]
        return out


def pdf_text(path):
    """The text layer of a PDF, page by page. A scanned page has none: OCR is not done here."""
    from pypdf import PdfReader
    return "\n\n".join(page.extract_text() or "" for page in PdfReader(path).pages)


MODELS = {"opf": {"mlx": OpfMlx, "onnx": OpfOnnx, "onnx-int8": OpfOnnx, "gguf": OpfOnnx},
          "pii-tracer": {"mlx": TracerMlx, "onnx": TracerOnnx, "onnx-int8": TracerOnnx, "gguf": TracerGguf}}
RUNTIMES = ["mlx", "onnx", "onnx-int8", "gguf"]


def artifact(name, runtime):
    """A model's artifact for a runtime; a runtime it has none for names the one it uses instead."""
    a = ARTIFACTS[name][runtime]
    return ARTIFACTS[name][a] if isinstance(a, str) else a


def local_dir(art):
    return MODELS_DIR / f"{art['repo'].replace('/', '--')}@{art['revision']}"


def download(names, runtime):
    """Fetches each model, saying so as it goes: into the Hugging Face cache, or as plain files into its own folder."""
    for n in names:
        print(json.dumps({"model": n, "status": "downloading"}), flush=True)
        art = artifact(n, runtime)
        if art["store"] == "hub":
            snapshot_download(art["repo"], allow_patterns=art.get("allow", art["files"]))
        else:
            snapshot_download(art["repo"], revision=art["revision"], allow_patterns=art["files"], local_dir=local_dir(art))
        print(json.dumps({"model": n, "status": "done"}), flush=True)


def load(name, runtime):
    m = MODELS[name][runtime](artifact(name, runtime))
    scan_windows(m, "warm up")
    return m


def serve(state, idle, names, runtime):
    lock = open(f"{state}.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return  # another scanner is starting or running
    loaded = {}
    for n in names:
        try:
            loaded[f"{n}:{runtime}"] = load(n, runtime)
        except Exception as err:
            # Loaded again by the first request for it, whose answer then says why it cannot be.
            print(f"{n}:{runtime} did not load: {type(err).__name__}: {err}", file=sys.stderr, flush=True)
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
                wanted, rt = body.get("models"), body.get("runtime")
                if not wanted or any(n not in MODELS for n in wanted) or rt not in RUNTIMES:
                    return self.reply(400, {"error": f"models must be some of {list(MODELS)} and runtime one of {RUNTIMES}, not {wanted}, {rt}"})
                for n in wanted:
                    if f"{n}:{rt}" not in loaded:
                        loaded[f"{n}:{rt}"] = load(n, rt)
                text = pdf_text(body["path"]) if "path" in body else body["text"]
                a = time.perf_counter()
                spans = [s for n in wanted for s in scan_windows(loaded[f"{n}:{rt}"], text)]
                self.reply(200, {"spans": spans, "ms": round((time.perf_counter() - a) * 1000, 1), **({"text": text} if "path" in body else {})})
            except Exception as err:
                self.reply(500, {"error": f"{type(err).__name__}: {err}"})

    # Single-threaded on purpose: MLX evaluation is not safe across threads, so requests take turns (ONNX alike).
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
    # A stop (SIGTERM) runs the exit hooks too, which stop a llama-server the scanner started.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    p = argparse.ArgumentParser()
    p.add_argument("--state")
    p.add_argument("--idle", type=float, default=1800)
    p.add_argument("--models", default="opf,pii-tracer")
    p.add_argument("--runtime", default="mlx", choices=RUNTIMES)
    p.add_argument("--download", action="store_true")
    p.add_argument("--spans", action="store_true")
    a = p.parse_args()
    names = a.models.split(",")
    if any(n not in MODELS for n in names):
        p.error(f"--models: some of {','.join(MODELS)}")
    if any(a.runtime not in ARTIFACTS[n] for n in names):
        p.error(f"--runtime {a.runtime}: not every one of {names} has it")
    if a.download:
        download(names, a.runtime)
    elif a.spans:
        texts = json.load(sys.stdin)
        loaded = {n: load(n, a.runtime) for n in names}
        print(json.dumps([[s for n in names for s in scan_windows(loaded[n], t)] for t in texts]))
    elif a.state is None:
        p.error("--state is required to serve")
    else:
        Path(a.state).parent.mkdir(parents=True, exist_ok=True)
        serve(a.state, a.idle, names, a.runtime)
    sys.exit(0)
