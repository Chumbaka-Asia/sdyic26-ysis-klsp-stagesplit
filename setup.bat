@echo off
REM One-time setup for Windows: creates the venv folder and installs packages.
cd /d "%~dp0"
where python >nul 2>nul || (echo Python not found. Install it from https://www.python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
if not exist venv (
  echo Creating virtual environment in .\venv ...
  python -m venv venv
)
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if not exist .env copy .env.example .env >nul
echo.
echo Downloading the Whisper speech model (only once; needs internet)...
python whisper_engine.py
echo.
echo Setup complete. Double-click run.bat to start the show.
pause
