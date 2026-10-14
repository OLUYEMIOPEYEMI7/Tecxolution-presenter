#!/bin/bash
# Start the Peculiar Voices Worship Presenter
cd "$(dirname "$0")"
fuser -k 4000/tcp 2>/dev/null
echo "Starting Worship Presenter..."
node server.js
