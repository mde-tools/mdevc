@echo off
cd /d "%~dp0"
call npx.cmd @vscode/vsce package --allow-missing-repository
pause