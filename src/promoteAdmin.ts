import path from 'node:path';
import { config } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function promoteAdmin(email: string): Promise<void> {
  try {
    const user = await prisma.usuario.update({
      where: { email: email.trim().toLowerCase() },
      data: { role: 'ADMIN' },
      select: { nombre: true, email: true },
    });
    console.log(`Administrador configurado: ${user.nombre} (${user.email}).`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new Error(`No existe una cuenta registrada con el correo ${email}.`);
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

const email = process.argv[2];
if (!email?.trim()) {
  console.error('Uso: npm run admin:promote -- correo@ejemplo.com');
  process.exitCode = 1;
} else {
  void promoteAdmin(email).catch((error: unknown) => {
    console.error('No se pudo promover la cuenta a administrador:', error);
    process.exitCode = 1;
  });
}
