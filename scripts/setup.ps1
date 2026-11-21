# BAYMAX one-time setup (run from the project root:  npm run setup)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Step 1: make sure Python is installed. Step 2: create the backend environment. Step 3: install the UI packages.
# Step 4: check for Ollama (the free local model engine).
Write-Host "`n[1/4] Checking Python..." -ForegroundColor Cyan
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { throw "Python 3.11+ is required. Install it from https://www.python.org/downloads/ (tick 'Add to PATH') and re-run." }
python --version

Write-Host "`n[2/4] Creating Python environment + installing backend packages..." -ForegroundColor Cyan
python -m venv backend\.venv
& backend\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
& backend\.venv\Scripts\python.exe -m pip install --quiet -r backend\requirements.txt

Write-Host "`n[3/4] Installing app + UI packages (npm)..." -ForegroundColor Cyan
npm install --no-audit --no-fund
npm --prefix frontend install --no-audit --no-fund

Write-Host "`n[4/4] Checking Ollama..." -ForegroundColor Cyan
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
  Write-Host "Ollama found. If you haven't yet, run:  ollama pull qwen2.5:7b" -ForegroundColor Green
} else {
  Write-Host "Ollama is not installed. Get it free from https://ollama.com/download, then run:  ollama pull qwen2.5:7b" -ForegroundColor Yellow
}

Write-Host "`nDone! Start BAYMAX with:  npm start" -ForegroundColor Green
