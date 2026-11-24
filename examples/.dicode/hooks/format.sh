#!/bin/sh
# PostToolUse hook: format a file after DiCode edits it. The hook payload arrives as JSON on stdin.
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tool_input.file_path||"")}catch{}})')
[ -n "$file" ] && npx --no-install prettier --write "$file" >/dev/null 2>&1
exit 0
