@echo off
setlocal
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Longitude needs Python 3 to run its local server.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this file again.
  pause
  exit /b 1
)
title Longitude
rem First run only: offer the one-time background removal download, so it
rem works offline. Asked once (web\vendor\first-run.json), and once more to
rem finish a download that was stopped; any problem leaves the download to the
rem app. Longitude opens when it is done.
%PY% tools\fetch_model.py --first-run
echo Starting Longitude. Keep this window open while you work; close it to stop.
%PY% serve.py --open --quiet
if errorlevel 1 pause
