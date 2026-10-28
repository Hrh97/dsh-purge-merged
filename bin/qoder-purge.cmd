@echo off
rem qoder-purge.cmd — runner for the Qoder purge patcher (used by the on-logon task)
node "%~dp0..\lib\qoder\qoder-purge.mjs" --auto %*
