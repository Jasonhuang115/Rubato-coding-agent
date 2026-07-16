#!/bin/bash
# SWE-bench Quick Start for Rubato
# ====================================
# Prerequisites: python3, git, docker
# ====================================

set -e

echo "=== SWE-bench Quick Start for Rubato ==="

# Step 1: Install SWE-bench Python package
echo ""
echo "Step 1: Installing swebench..."
pip3 install swebench datasets

# Step 2: Download SWE-bench Lite dataset (300 instances, manageable)
echo ""
echo "Step 2: Downloading SWE-bench Lite dataset..."
DATASET_DIR=~/.rubato/swebench-data
mkdir -p "$DATASET_DIR"

if [ ! -f "$DATASET_DIR/swe-bench-lite.json" ]; then
  python3 -c "
from datasets import load_dataset
ds = load_dataset('princeton-nlp/SWE-bench_Lite', split='test')
# Save as JSONL for our harness
import json
with open('$DATASET_DIR/swe-bench-lite.jsonl', 'w') as f:
    for item in ds:
        f.write(json.dumps(item) + '\n')
print(f'Saved {len(ds)} instances to $DATASET_DIR/swe-bench-lite.jsonl')
"
fi

# Step 3: Build rubato
echo ""
echo "Step 3: Building rubato..."
cd "$(dirname "$0")/.."
npm run build

# Step 4: Run predictions on N instances
echo ""
echo "Step 4: Running rubato on SWE-bench instances..."
N=${1:-3}  # default: 3 instances
echo "  Processing $N instance(s)..."
npx tsx scripts/swebench-run.ts \
  --dataset "$DATASET_DIR/swe-bench-lite.jsonl" \
  --output predictions.json \
  --max-instances "$N"

# Step 5: Run SWE-bench evaluation
echo ""
echo "Step 5: Running SWE-bench evaluation..."
python3 -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path predictions.json \
  --run_id rubato-v0.2 \
  --max_workers 1

echo ""
echo "=== Done! ==="
echo "Results in: predictions.json"
echo "Full SWE-bench report in the swebench output above."
