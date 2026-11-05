import path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const prisma = new PrismaClient();

export async function initDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    await Promise.all([
      prisma.usuario.count(),
      prisma.mascota.count(),
      prisma.turno.count(),
      prisma.notification.count(),
    ]);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('Base de datos lista.');
    })
    .catch((error: unknown) => {
      console.error('No se pudo inicializar la base de datos:', error);
      process.exitCode = 1;
    })
}
