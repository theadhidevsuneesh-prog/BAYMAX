# Bundles the Python backend into a self-contained folder (no Python needed on the target PC).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$be = Join-Path $root 'backend'
Set-Location $be

if (-not (Test-Path .venv\Scripts\python.exe)) { throw "Run 'npm run setup' first." }
$py = Join-Path $be '.venv\Scripts\python.exe'
& $py -m pip install --quiet -r requirements-dev.txt

# Clean old output, then bundle main.py and its libraries (the --collect-* flags include packages
# PyInstaller can't discover by itself, such as the speech models' runtimes).
Remove-Item -Recurse -Force dist, build -ErrorAction SilentlyContinue
& $py -m PyInstaller --noconfirm --clean --onedir --name baymax-backend `
  --collect-submodules uvicorn --collect-submodules websockets --collect-submodules anyio `
  --collect-all ddgs --collect-all primp --collect-submodules lxml `
  --collect-all faster_whisper --collect-all ctranslate2 --collect-all onnxruntime --collect-all piper `
  --collect-all av --collect-all tokenizers --collect-all huggingface_hub `
  --distpath dist --workpath build --specpath build `
  main.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
Write-Host "Backend bundle ready: backend\dist\baymax-backend" -ForegroundColor Green
