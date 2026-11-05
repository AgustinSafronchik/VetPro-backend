import './config';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from './db';

const secret = process.env.JWT_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) {
  throw new Error('Configura JWT_SECRET en backend/.env con un secreto aleatorio de al menos 32 bytes.');
}
const JWT_SECRET: string = secret;
const ISSUER = 'vetpro';
const AUDIENCE = 'vetpro-app';

type SessionUser = { id: number; role: string; sessionVersion: number; mustChangePassword: boolean };
declare global {
  namespace Express {
    interface Request { user: SessionUser }
  }
}

export function createAccessToken(user: Pick<SessionUser, 'id' | 'sessionVersion'>): string {
  return jwt.sign({ sessionVersion: user.sessionVersion }, JWT_SECRET, {
    algorithm: 'HS256', subject: String(user.id), issuer: ISSUER, audience: AUDIENCE, expiresIn: '2h',
  });
}

export async function requireSession(request: Request, response: Response, next: NextFunction): Promise<void> {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.header('authorization') ?? '');
  let claims: jwt.JwtPayload;
  try {
    if (!bearer) throw new Error('Token ausente');
    const decoded = jwt.verify(bearer[1], JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    if (typeof decoded === 'string' || !decoded.sub || !/^[1-9]\d*$/.test(decoded.sub) ||
        !Number.isSafeInteger(Number(decoded.sub)) || !Number.isSafeInteger(decoded.sessionVersion) ||
        decoded.sessionVersion < 0 || !Number.isInteger(decoded.exp) || !Number.isInteger(decoded.iat)) {
      throw new Error('Token inválido');
    }
    claims = decoded;
  } catch {
    response.status(401).json({ message: 'Tu sesión venció o no es válida. Iniciá sesión nuevamente.' });
    return;
  }
  try {
    const user = await prisma.usuario.findUnique({
      where: { id: Number(claims.sub) },
      select: { id: true, role: true, sessionVersion: true, mustChangePassword: true },
    });
    if (!user || user.sessionVersion !== claims.sessionVersion) {
      response.status(401).json({ message: 'Tu sesión ya no es válida. Iniciá sesión nuevamente.' });
      return;
    }
    request.user = user;
    const changingPassword = request.method === 'PATCH' && request.path === `/api/users/${user.id}/password`;
    const loggingOut = request.method === 'DELETE' && request.path === '/api/sessions';
    if (user.mustChangePassword && !changingPassword && !loggingOut) {
      response.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'Cambiá tu contraseña temporal para continuar.' });
      return;
    }
    next();
  } catch (error) { next(error); }
}

export function requireAdmin(request: Request, response: Response, next: NextFunction): void {
  if (request.user?.role !== 'ADMIN') {
    response.status(403).json({ message: 'Esta acción requiere una cuenta administradora.' });
    return;
  }
  next();
}
