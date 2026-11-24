@echo off
cd /d "%~dp0"
if not exist venv (echo Run setup.bat first. & pause & exit /b 1)
call venv\Scripts\activate.bat
start "" http://localhost:8000
python app.py
pause
