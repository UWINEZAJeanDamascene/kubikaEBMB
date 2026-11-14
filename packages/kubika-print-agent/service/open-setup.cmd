@echo off
sc start KubikaPrintAgent >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:19100/"
