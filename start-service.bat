@echo off
title PTWA WhatsApp Background Engine
cd /d %~dp0
echo Starting PTWA WhatsApp Socket Service...
node server.js
pause

