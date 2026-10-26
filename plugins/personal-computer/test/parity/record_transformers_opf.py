#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["torch==2.14.1", "transformers==5.21.0", "numpy", "tokenizers", "huggingface_hub", "pypdf"]
# ///
"""Records OpenAI Privacy Filter's reference spans: OpenAI's own weights (openai/privacy-filter) in transformers, fp32 on
the CPU, decoded as scan.py decodes every runtime. ONNX is compared with these (parity.py --against transformers):
every runtime off MLX agrees with them, and MLX differs on a few spans.

usage: uv run --script record_transformers_opf.py   writes baseline/opf-transformers.json
"""
import json, sys
from pathlib import Path

import torch
from huggingface_hub import snapshot_download
from transformers import AutoModelForTokenClassification

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "scanner")]
import scan  # noqa: E402
from parity import texts  # noqa: E402

REVISION = scan.ARTIFACTS["opf"]["onnx"]["revision"]


class OpfTransformers:
    name, window = "opf", scan.OPF_WINDOW

    def __init__(self):
        root = Path(snapshot_download("openai/privacy-filter", revision=REVISION,
                                      allow_patterns=["config.json", "model.safetensors", "tokenizer.json"]))
        self.model = AutoModelForTokenClassification.from_pretrained(root, dtype=torch.float32).eval()
        self.labels = scan.opf_labels(root)
        self.tables = scan.bioes_tables(self.labels)
        self.tok = scan.tokenizer(root / "tokenizer.json")

    @torch.inference_mode()
    def logits(self, ids, wins):
        out = []
        for a, b in wins:
            x = torch.tensor([ids[a:b]])
            out.append(self.model(input_ids=x, attention_mask=torch.ones_like(x)).logits[0].float().numpy())
        return out


m = OpfTransformers()
got = {n: sorted({(s["type"], s["start"], s["end"]) for s in scan.scan_windows(m, t)}) for n, t in texts().items()}
out = HERE / "baseline" / "opf-transformers.json"
out.write_text(json.dumps({n: [list(s) for s in v] for n, v in got.items()}, indent=0) + "\n")
print(f"recorded {out.name}: " + ", ".join(f"{n} {len(v)}" for n, v in got.items()))
