/**
 * eternal_v2 - Minimal Express server for Railway
 * - Listens on process.env.PORT (required by Railway)
 * - Provides health check and root page
 * - No external keys required
 */

const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Basic request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// Static files (optional)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Root
app.get('/', (req, res) => {
  res.type('text/plain').send('Kumao bot is running! 🐻\n');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});