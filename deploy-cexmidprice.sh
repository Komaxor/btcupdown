#!/bin/bash
set -e

cd /home/cyb0rg/btcupdown

echo "Pulling latest code..."
git pull

echo "Installing dependencies..."
npm install

echo "Running database setup..."
psql btcupdown < setup-db.sql

echo "Restarting service..."
sudo systemctl restart btcupdown

echo "Done. Checking status..."
sudo systemctl status btcupdown --no-pager
