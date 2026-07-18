@echo off
REM Fruma — Morpho-HyperEVM shadow monitor. Auto-restarts if it ever crashes.
cd /d "%~dp0"
:loop
call npx ts-node src/engine.ts >> "logs\fruma.log" 2>&1
echo [%date% %time%] Fruma exited, restarting in 10s >> "logs\fruma.log"
timeout /t 10 /nobreak >nul
goto loop
