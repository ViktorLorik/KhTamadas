@echo off
setlocal
cd /d "%~dp0"
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE (
  for /d %%i in ("%APPDATA%\JetBrains\IntelliJIdea*") do (
    for /d %%v in ("%%i\node\versions\*") do (
      if exist "%%v\node.exe" set "NODE=%%v\node.exe"
    )
  )
)
if not defined NODE (
  echo Node.js nem talalhato. Telepitsd: https://nodejs.org
  exit /b 1
)
if "%~1"=="" (
  "%NODE%" src\index.js jobs.json
) else (
  "%NODE%" src\index.js %*
)
