# Benchmarks

All numbers in this file come from [Artificial Analysis](https://artificialanalysis.ai), Intelligence Index v5.0.1 (higher is smarter), collected on **2026-11-10**. Prices are USD per 1M tokens (input / output). Speed is output tokens per second. The numbers are quoted from the linked pages, not rounded or invented. A second independent check opened each page the same day and matched them: Opus 59, Haiku 36, DeepSeek V4.1 Flash N/A (1017 checkpoint 33), Gemini 3.8 Flash 31, and OpenRouter's `z-ai/glm-5.3-flash:free` listed at $0. All prices and speeds matched.

| Model (Artificial Analysis name) | Index | Input $/1M | Output $/1M | Speed (tok/s) | Role here | Page |
|---|---|---|---|---|---|---|
| [Claude Fable 5.2 (Max)](https://artificialanalysis.ai/models/claude-fable-5-2) | 65 | 8.00 | 40.00 | 98 | — (shown for price comparison) | [link](https://artificialanalysis.ai/models/claude-fable-5-2) |
| [Claude Opus 5.5 (Max)](https://artificialanalysis.ai/models/claude-opus-5-5) | 59 | 4.00 | 20.00 | 115 | lead: the plan and every check | [link](https://artificialanalysis.ai/models/claude-opus-5-5) |
| [Claude Sonnet 5.5 (Max)](https://artificialanalysis.ai/models/claude-sonnet-5-5) | 55 | 2.00 | 10.00 | 151 | judgement slices (`sub-orchestrator-sonnet`) | [link](https://artificialanalysis.ai/models/claude-sonnet-5-5) |
| [Claude Haiku 5.5 (Max)](https://artificialanalysis.ai/models/claude-haiku-5-5) | 36 | 0.10 | 0.50 | 254 | pinned Claude fallback worker | [link](https://artificialanalysis.ai/models/claude-haiku-5-5) |
| [DeepSeek V4.1 Flash (Max)](https://artificialanalysis.ai/models/deepseek-v4-1-flash) | 33* | 0.29 | 1.20 | 225 | IQ builder (code, configs, precision) | [link](https://artificialanalysis.ai/models/deepseek-v4-1-flash) |
| [GLM-5.3 (Max)](https://artificialanalysis.ai/models/glm-5-3) | 32 | 1.40 | 4.40 | 67 | — (the workforce uses GLM-5.3-Flash) | [link](https://artificialanalysis.ai/models/glm-5-3) |
| [Gemini 3.8 Flash (High)](https://artificialanalysis.ai/models/gemini-3-8-flash) | 31 | 0.75 | 3.75 | 112 | file-reading scout | [link](https://artificialanalysis.ai/models/gemini-3-8-flash) |
| [GLM-5.3-Flash](https://artificialanalysis.ai/models/glm-5-3-flash) | 28 | 0.15 | 0.50 | 49 | EQ builder (prose, UX copy, naming) | [link](https://artificialanalysis.ai/models/glm-5-3-flash) |
| [GPT-6 Luna (max effort)](https://artificialanalysis.ai/models/gpt-6-luna) | 28 | 0.10 | 0.50 | 104 | sandboxed fallback agent (Codex CLI) | [link](https://artificialanalysis.ai/models/gpt-6-luna) |
| [Nemotron 3.5 Super VL](https://artificialanalysis.ai/models/nemotron-3-5-super-vl) | 14 | 0.17 | 0.50 | 257 | trivial jobs, long input, images | [link](https://artificialanalysis.ai/models/nemotron-3-5-super-vl) |
| [Nemotron 3 Ultra 550B A55B (Reasoning)](https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra-550b-a55b) | 12 | 0.60 | 2.70 | 191 | trivial jobs only | [link](https://artificialanalysis.ai/models/nvidia-nemotron-3-ultra-550b-a55b) |
| [North Mini Code](https://artificialanalysis.ai/models/north-mini-code) | 3 | free | free | 165 | code-shaped trivial jobs | [link](https://artificialanalysis.ai/models/north-mini-code) |
| LongCat 2.5 | not listed | n/a | n/a | n/a | text-only fallback (Hermes Agent) | not on Artificial Analysis on 2026-11-10 |

\* The DeepSeek V4.1 Flash main page shows N/A for the index. The 33 comes from its 1017 checkpoint page. Its prices and speed matched across both pages.

GPT-6 Luna's index (28) is its max-effort score; it scores lower at lower effort settings. That is why it is a fallback builder checked by locked tests and never a test writer, because a test writer must be at least as strong as the builder it checks.

## Read this table honestly

- The index measures reasoning on benchmarks. It does not measure taste, and it does not tell you what a model is like in your terminal.
- The free and cheap workers — DeepSeek V4.1 Flash (33), Gemini 3.8 Flash (31), GLM-5.3-Flash (28) — sit near Claude Haiku 5.5 (36) and far below Claude Opus 5.5 (59).
- They are good at reading, searching, drafting and building to a spec with a test. They are not good at judgement. Do not ask a worker for a decision.
- That is exactly the split this project uses: Opus decides, cheap workers do the reading and building, and a test or the lead checks every result.
- Price makes the split worth doing. Opus output costs 40x Haiku output per token ($20.00 vs $0.50), and Fable output costs 80x ($40.00 vs $0.50). Non-Claude workers additionally cost your Claude plan nothing.
- Do not expect "the same quality as Opus" from a worker. Expect Opus-quality decisions, with the bulk work done by models that cost your Claude plan nothing.
- Nemotron (12) is for trivial jobs only: list files, reformat a list, pull fields from pasted text. A wrong answer there is cheap to spot.
- No savings percentage is claimed anywhere in this project: there is no measured study. The benchmark placement and the price ratio are the only claims.
