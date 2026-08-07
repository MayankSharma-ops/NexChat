import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import authRouter     from './routes/auth.js';
import usersRouter    from './routes/users.js';
import friendsRouter  from './routes/friends.js';
import messagesRouter from './routes/messages.js';
import { initSocket } from './socket.js';

dotenv.config();

const app = express();
app.set('trust proxy', true);   // Trust all proxies in Render's chain
const httpServer = createServer(app);

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET','POST','PUT','DELETE','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

app.use(limiter);
app.use(express.json({ limit: '10kb' }));

// REST Routes
app.use('/api/auth',     authLimiter, authRouter);
app.use('/api/users',    usersRouter);
app.use('/api/friends',  friendsRouter);
app.use('/api/messages', messagesRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Attach Socket.IO to the HTTP server
initSocket(httpServer);

const PORT = Number(process.env.PORT) || 4000;
httpServer.listen(PORT, () => {
  console.log(`\n  Backend  →  http://localhost:${PORT}`);
  console.log(`  Health   →  http://localhost:${PORT}/health`);
  console.log(`  Socket   →  ws://localhost:${PORT}\n`);
});

export default app;
