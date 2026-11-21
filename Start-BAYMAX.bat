@echo off
rem Launch BAYMAX from source (run "npm run setup" once first).
cd /d "%~dp0"
if not exist node_modules (
  echo First-time setup needed. Running: npm run setup
  call npm run setup || exit /b 1
)
call npm start
