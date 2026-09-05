#!/usr/bin/env bash
# 生成发布产物目录 dist/（仅运行必需文件）。
# 用法：./build.sh ；然后在 uTools 开发者工具「发布新版/打包」时选择 dist/ 目录。
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist

cp plugin.json index.html preload.js dist/
cp -R engine js css vendor assets dist/

# 剔除系统垃圾文件
find dist -name '.DS_Store' -delete
find dist -name '._*' -delete

echo "dist/ 产物："
find dist -type f | sort
echo
du -sh dist | awk '{print "总大小: "$1}'
