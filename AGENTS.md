# Dandelion Agent Guide

## Purpose
Dandelion is a project aimed at creating a Session Saver - a server that hosts game sessions indefinitely - for a web game called ZOMBS.io (which doesn't save game sessions after the player leaves the tab).

## Requirements
- Must maintain stability for the session at all costs: do not trigger accidental disconnections.
- Must have a readable, contributor-friendly codebase.
- Keep code output concise.

## Tech Stack
- [Bun](https://bun.com): Package manager & runtime
- [ElysiaJS](https://elysiajs.com): API framework for managing pings 

## Knowledge Sources
- [zombs.io Wiki (llms.txt)](https://ayubloom.github.io/zombsWiki/llms.txt): Use when working on the core of the sessions saver, or ZOMBS-related terms.
- [ElysiaJS Documentation (llms.txt)](https://elysiajs.com/llms.txt): Use when working on the API

## Code Verification
- Run TypeScript type checking
- Run tests at `${PROJECT_ROOT}/tests/`.
