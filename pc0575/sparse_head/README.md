# Sparse head cho BGE-M3 ONNX (PC0575)

2 file `.npy` nay duoc trich tu `sparse_linear.pt` goc cua HuggingFace rev 5617a9f
(BAAI/bge-m3) — khong phai tu bien, khong phai mo phong.

- `sparse_linear.npy`: vector (1024,) float32 — trong so sparse head.
- `sparse_linear_bias.npy`: vector (1,) float32 = 0.04519653 — bias.

SHA-256:
- sparse_linear.npy: ecf456ee92e5f4ce04fdcaa56b44f1ef89d21a4ec5a32d21e17534f61819aa4c
- sparse_linear_bias.npy: ac9c745621f4013d231ecfeb94e271a1a4f9487b4d60249ba3c1992ecd99e442

Cach dung (theo ve P2 B7b): copy 2 file vao thu muc onnx
`local_runs\retrieval_models\bge-m3-5617a9f\onnx\` trong repo AIOS_habbit,
ROI TINH LAI `AIOS_BGE_ONNX_MODEL_CHECKSUM` (cay model doi vi them file),
roi chay smoke.
