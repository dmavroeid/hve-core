from __future__ import annotations

import os
import sys
from pathlib import Path

import nbformat
from nbconvert.preprocessors import ExecutePreprocessor, CellExecutionError
from PIL import Image


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: execute-notebook.py INPUT.ipynb OUTPUT.ipynb")

    input_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with input_path.open("r", encoding="utf-8") as handle:
        notebook = nbformat.read(handle, as_version=4)
    nbformat.validate(notebook)

    metadata = notebook.get("metadata", {})
    kernelspec = metadata.get("kernelspec", {})
    kernel_name = os.environ.get("QUEUE_DELAY_NOTEBOOK_KERNEL") or kernelspec.get("name") or "hve-simplified-pilot"

    executor = ExecutePreprocessor(timeout=300, kernel_name=kernel_name)
    resources = {"metadata": {"path": os.environ.get("QUEUE_DELAY_NOTEBOOK_WORKSPACE_DIR", str(input_path.parent))}}
    executor.preprocess(notebook, resources=resources)

    with output_path.open("w", encoding="utf-8") as handle:
        nbformat.write(notebook, handle)

    figures = list((input_path.parent / "figures").glob("*.png"))
    if not figures:
        print("Missing required PNG chart exports in deliverable/figures", file=sys.stderr)
        return 1
    for figure in figures:
        with Image.open(figure) as image:
            image.verify()
    print(f"Executed {len(notebook.cells)} cells; verified {len(figures)} PNG charts")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CellExecutionError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError) as error:
        print(f"Notebook validation/execution setup error: {error}", file=sys.stderr)
        raise SystemExit(2)
