export default {
  "opf": {
    "mlx": {
      "repo": "mlx-community/openai-privacy-filter-bf16",
      "store": "hub",
      "files": [
        "model.safetensors",
        "tokenizer.json"
      ],
      "allow": [
        "*"
      ],
      "size": "2.6 GB"
    },
    "onnx": {
      "repo": "openai/privacy-filter",
      "revision": "7ffa9a043d54d1be65afb281eddf0ffbe629385b",
      "store": "local",
      "files": [
        "config.json",
        "tokenizer.json",
        "onnx/model.onnx",
        "onnx/model.onnx_data",
        "onnx/model.onnx_data_1",
        "onnx/model.onnx_data_2"
      ],
      "graph": "onnx/model.onnx",
      "size": "5.6 GB"
    },
    "gguf": "onnx",
    "onnx-int8": {
      "repo": "openai/privacy-filter",
      "revision": "7ffa9a043d54d1be65afb281eddf0ffbe629385b",
      "store": "local",
      "files": [
        "config.json",
        "tokenizer.json",
        "onnx/model_quantized.onnx",
        "onnx/model_quantized.onnx_data"
      ],
      "graph": "onnx/model_quantized.onnx",
      "size": "1.6 GB"
    }
  },
  "pii-tracer": {
    "mlx": {
      "repo": "perplexity-ai/PII-Tracer",
      "store": "hub",
      "files": [
        "config.json",
        "model.safetensors",
        "tokenizer.json"
      ],
      "size": "1.1 GB"
    },
    "onnx": {
      "repo": "lemonade-sdk/pplx-pii-masking-onnx",
      "revision": "5ba4e413b78ff0f83d3c9cddee1bb5fdccbeee00",
      "store": "local",
      "files": [
        "model.onnx",
        "model.onnx.data",
        "tokenizer.json"
      ],
      "graph": "model.onnx",
      "size": "2.4 GB"
    },
    "gguf": {
      "repo": "perplexity-ai/PII-Tracer-GGUF",
      "revision": "79277a185c6d0a93ab29448e6981ebc722839c2c",
      "store": "local",
      "files": [
        "pplx-pii-masking-backbone-f16.gguf",
        "heads.safetensors",
        "pii_head_config.json",
        "tokenizer.json"
      ],
      "graph": "pplx-pii-masking-backbone-f16.gguf",
      "size": "1.2 GB"
    },
    "onnx-int8": {
      "repo": "maskmyai/pii-tracer-onnx",
      "revision": "2f2b8014bbbca7f1aa2795adb3af8aa80b3a0b58",
      "store": "local",
      "files": [
        "pii-tracer/model_int8.onnx",
        "pii-tracer/tokenizer.json",
        "pii-tracer/LICENSE"
      ],
      "graph": "pii-tracer/model_int8.onnx",
      "tokenizer": "pii-tracer/tokenizer.json",
      "size": "0.9 GB"
    }
  }
}
