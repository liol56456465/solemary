@echo off
rem Meowist logs: shows the logs of the bot running on Replit, live. Read-only.
rem Settings (Replit address + token) are in .logviewer.env in the repo folder.
title Meowist logs
wsl.exe -d Ubuntu --cd /home/ramazinas/solemary -- bash -lc "source /home/ramazinas/.nvm/nvm.sh && node --env-file=.logviewer.env scripts/watch-logs.js"
pause
