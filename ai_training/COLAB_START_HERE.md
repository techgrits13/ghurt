# GHURT AI Coach: Colab Start

Open Google Colab, choose **Runtime > Change runtime type > T4 GPU**, then paste these cells.

## Cell 1: Mount Drive

```python
from google.colab import drive
drive.mount('/content/drive')
```

## Cell 2: Install PyTorch Check

```python
import torch
print("CUDA:", torch.cuda.is_available())
print("GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU only")
```

If it says CPU only, change runtime type to GPU before training.

## Cell 3: Upload Trainer

Upload `ai_training/train_ghurt_selfplay.py` from this repo into Colab's `/content` folder, or run:

```python
from google.colab import files
files.upload()  # choose train_ghurt_selfplay.py
```

## Cell 4: First Training Run

Start small today to confirm it works:

```python
!python /content/train_ghurt_selfplay.py \
  --out /content/drive/MyDrive/ghurt_ai \
  --target-games 50000 \
  --batch-games 128 \
  --checkpoint-every 2048
```

## Cell 5: Long Run

After the small run is stable, resume and push toward real data:

```python
!python /content/train_ghurt_selfplay.py \
  --out /content/drive/MyDrive/ghurt_ai \
  --target-games 3000000 \
  --batch-games 256 \
  --checkpoint-every 4096
```

Colab can disconnect. That is okay. Run Cell 5 again and it resumes from:

```text
/content/drive/MyDrive/ghurt_ai/ghurt_coach_checkpoint.pt
```

The app-facing export appears here:

```text
/content/drive/MyDrive/ghurt_ai/ghurt_coach_model.json
```

## What To Watch

- `loss` should generally drift down over time, but it will bounce.
- `speed` tells you games per second. Free T4 sessions vary a lot.
- `avg_turns` should not explode forever. If it does, stop and lower `batch-games`.
- The first useful model is probably after `500,000+` games. The serious target is `3,000,000`.

## After Training

Download `ghurt_coach_model.json`. That file is what we will bundle into the app and lock behind the paid coach plan:

- `20 KES` for 24 hours
- `50 KES` for 5 days

The mobile app should still keep the model offline after download/bundle; payment unlocks access, not cloud inference.
