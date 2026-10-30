"""The combat MLP and its external-normalization ONNX export.

bridge/policy.js:13 feeds observations and reads raw logits. Normalization and
sigmoid therefore deliberately remain outside this graph.
"""
from __future__ import annotations

from pathlib import Path

import onnx
import torch
from torch import nn


class Policy(nn.Module):
    def __init__(self, input_size, output_size):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_size, 64), nn.ReLU(),
            nn.Linear(64, 64), nn.ReLU(), nn.Linear(64, output_size),
        )

    def forward(self, observations):
        return self.net(observations)


def export_onnx(model, path, input_size, output_size):
    """Export a CPU model with dynamic batch size and fixed feature width."""
    path = Path(path)
    model.cpu().eval()
    torch.onnx.export(
        model, (torch.zeros((1, input_size), dtype=torch.float32),), str(path),
        input_names=["observations"], output_names=["logits"],
        dynamic_axes={"observations": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17, dynamo=False, external_data=False,
    )
    graph = onnx.load(str(path))
    onnx.checker.check_model(graph)
    for value, name, width in (
        (graph.graph.input[0], "observations", input_size),
        (graph.graph.output[0], "logits", output_size),
    ):
        tensor = value.type.tensor_type
        if (value.name != name or tensor.elem_type != onnx.TensorProto.FLOAT
                or len(tensor.shape.dim) != 2 or tensor.shape.dim[1].dim_value != width):
            raise ValueError(f"invalid ONNX {name} contract")
    return path
