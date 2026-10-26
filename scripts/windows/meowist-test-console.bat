@echo off
rem Meowist test console: starts the local test database and the bot (test mode)
rem in this window. Logs scroll here; type admin commands at the "meowist>" prompt.
rem Type "stop" (or press Ctrl+C) to shut the bot down. Edit the WSL path below if
rem the repo lives somewhere else.
title Meowist test console
wsl.exe -d Ubuntu --cd /home/ramazinas/solemary -- bash -lc "docker compose -f docker-compose.test.yml up -d --wait && npm run start:test"
echo.
echo The bot has stopped.
pause
