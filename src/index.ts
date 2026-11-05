import './config';
import cors from 'cors';
import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { createAccessToken, requireSession, requireAdmin } from './auth';
import { hashPassword, verifyPassword, validPassword, temporaryPassword } from './passwords';
import { initDatabase } from './initDb';

const app = express();
async function limitarNotificaciones(tx: Prisma.TransactionClient, userId: number) {
  const avisos = await tx.notification.findMany({ where: { userId }, orderBy: { id: 'desc' }, select: { id: true, createdAt: true } });
  const limite = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const antiguas = avisos.filter((aviso, indice) => {
    const fecha = aviso.createdAt.includes('T') ? aviso.createdAt : `${aviso.createdAt.replace(' ', 'T')}Z`;
    return indice >= 15 || new Date(fecha).getTime() <= limite;
  });
  if (antiguas.length) await tx.notification.deleteMany({ where: { id: { in: antiguas.map((aviso) => aviso.id) } } });
}
const port = Number(process.env.PORT || 3000);
const APPOINTMENT_REMINDER_WINDOW_MS = 60 * 60 * 1000;

const TITULO_RECORDATORIO_TURNO = 'Tu turno se acerca';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT debe ser un numero entero entre 1 y 65535.');
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use('/api', (request, response, next) => {
  delete request.headers['if-none-match'];
  delete request.headers['if-modified-since'];
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

function parseId(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function formatearFechaLarga(fecha: string): string {
  const partes = fecha.split('-');
  return partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : fecha;
}

async function sedeConDireccion(sede: string): Promise<string> {
  const registro = await prisma.sede.findUnique({ where: { nombre: sede } });
  return registro ? `${sede} (${registro.direccion})` : sede;
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidBirthDate(value: unknown): value is string {
  if (!isValidDateOnly(value)) return false;
  const ahora = new Date();
  const hoy = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
  return value <= hoy;
}

function isValidAppointmentSlot(fecha: string, hora: string, sede: { dias: string; horaDesde: string; horaHasta: string }): boolean {
  if (!isValidDateOnly(fecha) || !/^([01]\d|2[0-3]):(00|30)$/.test(hora)) return false;
  const [year, month, day] = fecha.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dia = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'][date.getDay()];
  let dias: unknown;
  try { dias = JSON.parse(sede.dias); } catch { return false; }
  if (!Array.isArray(dias) || !dias.includes(dia)) return false;
  const minutos = (valor: string) => { const [h, m] = valor.split(':').map(Number); return h * 60 + m; };
  const inicio = minutos(hora), desde = minutos(sede.horaDesde), hasta = minutos(sede.horaHasta);
  const [h, m] = hora.split(':').map(Number);
  return inicio >= desde && inicio + 30 <= hasta && (inicio - desde) % 30 === 0 && new Date(year, month - 1, day, h, m) > new Date();
}

function isMissingRecord(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

async function createUpcomingAppointmentReminders(userId: number): Promise<void> {
  const hoy = new Date();
  const fechaActual = [
    hoy.getFullYear(),
    String(hoy.getMonth() + 1).padStart(2, '0'),
    String(hoy.getDate()).padStart(2, '0'),
  ].join('-');
  const turnos = await prisma.turno.findMany({
    where: { userId, fecha: { gte: fechaActual }, recordatorioEnviadoEn: null, llegadaEn: null, atendidoEn: null },
    include: {
      mascota: { select: { nombre: true, foto: true } },

      user: { select: { role: true } },
    },
  });
  const ahora = Date.now();

  for (const turno of turnos) {

    if (turno.user.role === 'ADMIN') continue;

    const inicioTurno = new Date(`${turno.fecha}T${turno.hora}:00`).getTime();
    const tiempoRestante = inicioTurno - ahora;
    if (tiempoRestante <= 0 || tiempoRestante > APPOINTMENT_REMINDER_WINDOW_MS) continue;

    try {
      const sede = await sedeConDireccion(turno.sede);
      await prisma.$transaction(async (transaction) => {
        const actualizado = await transaction.turno.updateMany({
          where: {
            id: turno.id,
            fecha: turno.fecha,
            hora: turno.hora,
            recordatorioEnviadoEn: null,
            llegadaEn: null, atendidoEn: null,
          },
          data: { recordatorioEnviadoEn: new Date().toISOString() },
        });
        if (actualizado.count === 0) return null;

        const aviso = await transaction.notification.create({
          data: {
            userId: turno.userId,
            turnoId: turno.id,
            mascotaNombre: turno.mascota.nombre,
            mascotaFoto: turno.mascota.foto,
            title: TITULO_RECORDATORIO_TURNO,
            message: `Dentro de aproximadamente una hora tienes un turno de ${turno.tipo} para ${turno.mascota.nombre} en la sede ${sede}.`,
          },
        });
        await limitarNotificaciones(transaction, turno.userId);
        return aviso;
      });
    } catch (error) {
      console.error(`No se pudo crear el recordatorio del turno ${turno.id}:`, error);
      throw error;
    }
  }
}

const SEXOS_MASCOTA = ['Macho', 'Hembra'];

app.get('/api/health', async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return response.json({ ok: true });
  } catch (error) {
    console.error('La comprobacion de la base de datos fallo:', error);
    return response.status(503).json({ ok: false, message: 'La base de datos no esta disponible.' });
  }
});

app.get('/api/sedes', requireSession, async (request, response) => {
  try {
    const sedes = await prisma.sede.findMany({ orderBy: { nombre: 'asc' } });
    return response.json(sedes.map((sede) => ({ ...sede, dias: JSON.parse(sede.dias) })));
  } catch (error) {
    console.error('No se pudieron consultar las sedes:', error);
    return response.status(500).json({ message: 'No se pudieron consultar las sedes.' });
  }
});

async function guardarSede(request: express.Request, response: express.Response): Promise<void> {
  const id = typeof request.params.id === 'string' ? parseId(request.params.id) : null;
  if (request.params.id !== undefined && id === null) {
    response.status(400).json({ message: 'El id de sede no es válido.' }); return;
  }
  const { nombre, direccion, dias, horaDesde, horaHasta } = request.body ?? {};
  const diasValidos = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
  const horaValida = (valor: unknown): valor is string =>
    typeof valor === 'string' && /^([01]\d|2[0-3]):(00|30)$/.test(valor);
  if (typeof nombre !== 'string' || nombre.trim().length < 3 ||
      typeof direccion !== 'string' || !direccion.trim() || !Array.isArray(dias) ||
      dias.length === 0 || !dias.every((dia: unknown) => typeof dia === 'string' && diasValidos.includes(dia)) ||
      new Set(dias).size !== dias.length || !horaValida(horaDesde) || !horaValida(horaHasta) || horaDesde >= horaHasta) {
    response.status(400).json({ message: 'Revisa nombre, dirección, días y horarios de la sede.' }); return;
  }
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const repetida = await tx.sede.findFirst({ where: { nombre: nombre.trim(), ...(id === null ? {} : { id: { not: id } }) } });
      if (repetida) return 'duplicada' as const;
      const data = { nombre: nombre.trim(), direccion: direccion.trim(), dias: JSON.stringify(dias), horaDesde, horaHasta };
      if (id === null) return tx.sede.create({ data });
      const anterior = await tx.sede.findUnique({ where: { id } });
      if (!anterior) return null;
      const sede = await tx.sede.update({ where: { id }, data });
      if (anterior.nombre !== sede.nombre) {
        await tx.turno.updateMany({ where: { sede: anterior.nombre }, data: { sede: sede.nombre } });
        await tx.notification.updateMany({ where: { sede: anterior.nombre }, data: { sede: sede.nombre } });
      }
      return sede;
    });
    if (resultado === 'duplicada') { response.status(409).json({ message: 'Ya existe una sede con ese nombre.' }); return; }
    if (!resultado) { response.status(404).json({ message: 'No se encontró la sede.' }); return; }
    response.status(id === null ? 201 : 200).json({ ...resultado, dias: JSON.parse(resultado.dias) });
  } catch (error) {
    console.error('No se pudo guardar la sede:', error);
    response.status(500).json({ message: 'No se pudo guardar la sede.' });
  }
}

app.post('/api/admin/sedes', requireSession, requireAdmin, guardarSede);
app.patch('/api/admin/sedes/:id', requireSession, requireAdmin, guardarSede);
app.delete('/api/admin/sedes/:id', requireSession, requireAdmin, async (request, response) => {
  const id = parseId(request.params.id);
  if (id === null) return response.status(400).json({ message: 'El id de sede no es válido.' });
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const sede = await tx.sede.findUnique({ where: { id } });
      if (!sede) return 'no-existe';
      if (await tx.turno.count({ where: { sede: sede.nombre } })) return 'tiene-turnos';
      await tx.sede.delete({ where: { id } });
      return 'eliminada';
    });
    if (resultado === 'no-existe') return response.status(404).json({ message: 'No se encontró la sede.' });
    if (resultado === 'tiene-turnos') return response.status(409).json({ message: 'La sede tiene turnos asociados y no se puede eliminar.' });
    return response.status(204).send();
  } catch (error) {
    console.error('No se pudo eliminar la sede:', error);
    return response.status(500).json({ message: 'No se pudo eliminar la sede.' });
  }
});

app.get('/api/mascotas', requireSession, async (request, response) => {
  const userId = request.user.id;


  try {
    const mascotas = await prisma.mascota.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return response.json(mascotas);
  } catch (error) {
    console.error('No se pudieron consultar las mascotas:', error);
    return response.status(500).json({ message: 'No se pudieron consultar las mascotas.' });
  }
});

app.post('/api/mascotas', requireSession, async (request, response) => {
  const { nombre, especie, raza, sexo, fechaNacimiento, foto } = request.body ?? {};
  const userId = request.user.id;

  if (
    typeof nombre !== 'string' ||
    !nombre.trim() ||
    typeof especie !== 'string' ||
    !especie.trim()
  ) {
    return response.status(400).json({
      message: 'Ingresa el nombre, la especie y un usuario valido para la mascota.',
    });
  }

  if (raza !== undefined && raza !== null && typeof raza !== 'string') {
    return response.status(400).json({ message: 'La raza no es valida.' });
  }
  if (sexo !== undefined && sexo !== null && !SEXOS_MASCOTA.includes(String(sexo))) {
    return response.status(400).json({ message: 'El sexo tiene que ser Macho o Hembra.' });
  }
  if (!isValidBirthDate(fechaNacimiento)) return response.status(400).json({ message: 'Ingresá una fecha de nacimiento válida que no sea futura.' });
  if (
    foto !== undefined &&
    foto !== null &&
    (typeof foto !== 'string' ||
      foto.length > 4_000_000 ||
      !/^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(foto))
  ) {
    return response.status(400).json({ message: 'La foto no es valida o es demasiado grande.' });
  }

  try {
    const usuarioExiste = await prisma.usuario.findUnique({ where: { id: userId }, select: { id: true } });
    if (!usuarioExiste) {
      return response.status(404).json({ message: 'No se encontro el usuario dueño de la mascota.' });
    }

    const mascota = await prisma.$transaction(async (tx) => {
      const cantidad = await tx.mascota.count({ where: { userId } });
      if (cantidad >= 5) return null;
      return tx.mascota.create({
      data: {
        nombre: nombre.trim(),
        especie: especie.trim(),
        raza: typeof raza === 'string' && raza.trim() ? raza.trim() : null,
        sexo: SEXOS_MASCOTA.includes(String(sexo)) ? String(sexo) : null,
        fechaNacimiento,
        foto: foto ?? null,
        user: { connect: { id: userId } },
      },
      });
    });
    if (!mascota) return response.status(409).json({ message: 'Tu plan permite un máximo de 5 mascotas.' });
    return response.status(201).json(mascota);
  } catch (error) {
    console.error('No se pudo crear la mascota:', error);
    return response.status(500).json({ message: 'No se pudo crear la mascota.' });
  }
});

app.patch('/api/mascotas/:id', requireSession, async (request, response) => {
  const id = parseId(request.params.id);
  const userId = request.user.id;
  if (id === null) {
    return response.status(400).json({ message: 'Indica un id de mascota válido.' });
  }


  const { nombre, especie, raza, sexo, fechaNacimiento, foto } = request.body ?? {};
  const data: {
    nombre?: string;
    especie?: string;
    raza?: string | null;
    sexo?: string | null;
    fechaNacimiento?: string;
    foto?: string | null;
  } = {};

  if (nombre !== undefined) {
    if (typeof nombre !== 'string' || !nombre.trim()) {
      return response.status(400).json({ message: 'El nombre no es valido.' });
    }
    data.nombre = nombre.trim();
  }
  if (especie !== undefined) {
    if (typeof especie !== 'string' || !especie.trim()) {
      return response.status(400).json({ message: 'La especie no es valida.' });
    }
    data.especie = especie.trim();
  }
  if (raza !== undefined) {
    if (raza !== null && typeof raza !== 'string') {
      return response.status(400).json({ message: 'La raza no es valida.' });
    }
    data.raza = typeof raza === 'string' && raza.trim() ? raza.trim() : null;
  }
  if (sexo !== undefined) {
    if (sexo !== null && !SEXOS_MASCOTA.includes(String(sexo))) {
      return response.status(400).json({ message: 'El sexo tiene que ser Macho o Hembra.' });
    }
    data.sexo = SEXOS_MASCOTA.includes(String(sexo)) ? String(sexo) : null;
  }
  if (fechaNacimiento !== undefined) {
    if (!isValidBirthDate(fechaNacimiento)) return response.status(400).json({ message: 'Ingresá una fecha de nacimiento válida que no sea futura.' });
    data.fechaNacimiento = fechaNacimiento;
  }
  if (foto !== undefined) {
    if (
      foto !== null &&
      (typeof foto !== 'string' ||
        foto.length > 4_000_000 ||
        !/^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(foto))
    ) {
      return response
        .status(400)
        .json({ message: 'La foto no es valida o es demasiado grande.' });
    }
    data.foto = foto;
  }
  if (Object.keys(data).length === 0) {
    return response.status(400).json({ message: 'No hay campos para actualizar.' });
  }

  try {
    const mascotaPropia = await prisma.mascota.findFirst({ where: { id, userId } });
    if (!mascotaPropia) {
      return response.status(404).json({ message: 'No se encontro la mascota de ese usuario.' });
    }
    const mascota = await prisma.mascota.update({ where: { id }, data });
    return response.json(mascota);
  } catch (error) {
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontro la mascota.' });
    }
    console.error('No se pudo actualizar la mascota:', error);
    return response.status(500).json({ message: 'No se pudo actualizar la mascota.' });
  }
});

app.delete('/api/mascotas/:id', requireSession, async (request, response) => {
  const id = parseId(request.params.id);
  const userId = request.user.id;
  if (id === null) {
    return response.status(400).json({ message: 'Indica un id de mascota válido.' });
  }


  try {
    const resultado = await prisma.mascota.deleteMany({ where: { id, userId } });
    if (resultado.count === 0) {
      return response.status(404).json({ message: 'No se encontro la mascota de ese usuario.' });
    }
    return response.status(204).send();
  } catch (error) {
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontro la mascota.' });
    }
    console.error('No se pudo eliminar la mascota:', error);
    return response.status(500).json({ message: 'No se pudo eliminar la mascota.' });
  }
});

const PREFIJO_CHECK_IN = 'vetpro://check-in';

async function sedeDeCheckIn(code: unknown): Promise<string | null> {
  if (typeof code !== 'string') return null;
  const [base, consulta] = code.split('?');
  if (base !== PREFIJO_CHECK_IN) return null;
  const params = new URLSearchParams(consulta ?? '');
  const id = parseId(params.get('sedeId') ?? undefined);
  const nombre = params.get('sede');
  const sede = id !== null ? await prisma.sede.findUnique({ where: { id } }) : nombre ? await prisma.sede.findUnique({ where: { nombre } }) : null;
  return sede?.nombre ?? null;
}

app.get('/api/turnos/disponibilidad', requireSession, async (request, response) => {
  const user = request.user;

  const mes =
    typeof request.query.mes === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(request.query.mes)
      ? request.query.mes
      : null;
  if (!mes) {
    return response.status(400).json({ message: 'Indica un mes válido en formato AAAA-MM.' });
  }
  const sede = request.query.sede;
  if (typeof sede !== 'string' || !(await prisma.sede.findUnique({ where: { nombre: sede } }))) {
    return response.status(400).json({ message: 'Indica una sede válida para consultar disponibilidad.' });
  }

  try {
    const turnos = await prisma.turno.findMany({
      where: { fecha: { startsWith: mes }, sede },
      select: { fecha: true, hora: true },
    });
    return response.json(turnos);
  } catch (error) {
    console.error('No se pudo consultar la disponibilidad de turnos:', error);
    return response.status(500).json({ message: 'No se pudo consultar la disponibilidad.' });
  }
});

app.get('/api/turnos', requireSession, async (request, response) => {
  const userId = request.user.id;


  try {
    const turnos = await prisma.turno.findMany({
      where: { userId },
      include: {
        mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
      },
      orderBy: [{ fecha: 'asc' }, { hora: 'asc' }],
    });
    return response.json(turnos);
  } catch (error) {
    console.error('No se pudieron consultar los turnos:', error);
    return response.status(500).json({ message: 'No se pudieron consultar los turnos.' });
  }
});

app.delete('/api/turnos/:id', requireSession, async (request, response) => {
  const user = request.user;

  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id del turno no es válido.' });
  }

  try {
    const turno = await prisma.turno.findFirst({
      where: { id, userId: user.id },
      select: { id: true, atendidoEn: true, llegadaEn: true },
    });

    if (!turno) {
      return response.status(404).json({ message: 'No se encontró el turno.' });
    }
    if (turno.atendidoEn) {
      return response.status(409).json({ message: 'Ese turno ya fue atendido.' });
    }
    if (turno.llegadaEn) {
      return response
        .status(409)
        .json({ message: 'Ya te presentaste en la sede, el turno no se puede cancelar.' });
    }

    await prisma.turno.delete({ where: { id: turno.id } });
    return response.json({ id: turno.id, cancelado: true });
  } catch (error) {
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontró el turno.' });
    }
    console.error('No se pudo cancelar el turno del cliente:', error);
    return response.status(500).json({ message: 'No se pudo cancelar el turno.' });
  }
});

app.post('/api/turnos/check-in', requireSession, async (request, response) => {
  const user = request.user;
  if (user.role === 'ADMIN') {
    return response.status(403).json({ message: 'El registro de llegada es para cuentas de usuario.' });
  }

  const sede = await sedeDeCheckIn(request.body?.code);
  if (sede === null) {
    return response.status(400).json({ message: 'El código QR no es válido.' });
  }

  const ahora = new Date();
  const fechaActual = [
    ahora.getFullYear(),
    String(ahora.getMonth() + 1).padStart(2, '0'),
    String(ahora.getDate()).padStart(2, '0'),
  ].join('-');

  try {
    const turno = await prisma.turno.findFirst({
      where: { userId: user.id, fecha: fechaActual, sede, llegadaEn: null, atendidoEn: null },
      include: {
        mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
      },
      orderBy: [{ hora: 'asc' }, { id: 'asc' }],
    });
    if (!turno) {
      return response.status(404).json({
        message: `No tienes turnos para hoy en ${await sedeConDireccion(sede)}.`,
      });
    }

    const llegadaEn = ahora.toISOString();
    const actualizacion = await prisma.turno.updateMany({
      where: { id: turno.id, userId: user.id, llegadaEn: null },
      data: { llegadaEn },
    });
    if (actualizacion.count === 0) {
      return response.status(409).json({ message: 'La llegada de este turno ya fue registrada.' });
    }

    return response.json({
      turno: { ...turno, llegadaEn },
      sede,
      yaRegistrado: false,
    });
  } catch (error) {
    console.error('No se pudo registrar la llegada del turno:', error);
    return response.status(500).json({ message: 'No se pudo registrar la llegada.' });
  }
});

app.post('/api/turnos', requireSession, async (request, response) => {
  const usuario = request.user;
  const { mascotaId, tipo, sede, fecha, hora } = request.body ?? {};
  const userId = request.user.id;

  if (
    !Number.isInteger(mascotaId) ||
    mascotaId <= 0
  ) {
    return response.status(400).json({ message: 'Indica un usuario y una mascota validos.' });
  }
  if (typeof tipo !== 'string' || !['Control', 'Vacunas', 'Estética'].includes(tipo)) {
    return response.status(400).json({ message: 'El tipo de turno no es valido.' });
  }
  if (
    typeof sede !== 'string' ||
    !(await prisma.sede.findUnique({ where: { nombre: sede } }))
  ) {
    return response.status(400).json({ message: 'Selecciona una sede válida.' });
  }
  if (!isValidDateOnly(fecha)) {
    return response.status(400).json({ message: 'La fecha debe ser una fecha real en formato AAAA-MM-DD.' });
  }
  const sedeConfigurada = await prisma.sede.findUnique({ where: { nombre: sede } });
  if (typeof hora !== 'string' || !sedeConfigurada || !isValidAppointmentSlot(fecha, hora, sedeConfigurada)) {
    return response.status(400).json({
      message: 'Elige un horario futuro dentro de los días y horarios de atención de la sede.',
    });
  }

  try {
    const mascota = await prisma.mascota.findFirst({
      where: { id: mascotaId, userId },
      select: { id: true },
    });
    if (!mascota) {
      return response.status(404).json({ message: 'La mascota no existe o no pertenece a ese usuario.' });
    }

    const turno = await prisma.$transaction(async (transaction) => {
      const configuracion = await transaction.sede.findUnique({ where: { nombre: sede } });
      if (!configuracion || !isValidAppointmentSlot(fecha, hora, configuracion)) return 'horario-invalido' as const;
      const ocupado = await transaction.turno.findFirst({
        where: { fecha, hora, sede },
        select: { id: true },
      });
      if (ocupado) return null;

      return transaction.turno.create({
        data: {
          tipo,
          sede,
          fecha,
          hora,
          user: { connect: { id: userId } },
          mascota: { connect: { id: mascotaId } },
        },
        include: {
          mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
        },
      });
    });
    if (turno === 'horario-invalido') {
      return response.status(400).json({ message: 'El horario ya no está disponible en esta sede.' });
    }
    if (!turno) {
      return response.status(409).json({ message: 'Ese horario acaba de ser ocupado. Elige otro.' });
    }
    return response.status(201).json(turno);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ message: 'Ese horario acaba de ser ocupado. Elige otro.' });
    console.error('No se pudo registrar el turno:', error);
    return response.status(500).json({ message: 'No se pudo registrar el turno.' });
  }
});

app.post('/api/admin/turnos', requireSession, requireAdmin, async (request, response) => {
  const { mascotaId, tipo, sede, fecha, hora } = request.body ?? {};

  if (!Number.isInteger(mascotaId) || mascotaId <= 0) {
    return response.status(400).json({ message: 'Indica una mascota válida.' });
  }
  if (typeof tipo !== 'string' || !['Control', 'Vacunas', 'Estética'].includes(tipo)) {
    return response.status(400).json({ message: 'El tipo de turno no es valido.' });
  }
  if (
    typeof sede !== 'string' ||
    !(await prisma.sede.findUnique({ where: { nombre: sede } }))
  ) {
    return response.status(400).json({ message: 'Selecciona una sede válida.' });
  }
  if (!isValidDateOnly(fecha)) {
    return response
      .status(400)
      .json({ message: 'La fecha debe ser una fecha real en formato AAAA-MM-DD.' });
  }
  const sedeConfigurada = await prisma.sede.findUnique({ where: { nombre: sede } });
  if (typeof hora !== 'string' || !sedeConfigurada || !isValidAppointmentSlot(fecha, hora, sedeConfigurada)) {
    return response.status(400).json({
      message: 'Elige un horario futuro dentro de los días y horarios de atención de la sede.',
    });
  }

  try {
    const mascota = await prisma.mascota.findFirst({
      where: { id: mascotaId, userId: { not: null } },
      select: { id: true, userId: true },
    });
    if (!mascota || mascota.userId === null) {
      return response.status(404).json({ message: 'La mascota no existe o no tiene dueño.' });
    }

    const duenoId = mascota.userId;

    const turno = await prisma.$transaction(async (transaction) => {
      const configuracion = await transaction.sede.findUnique({ where: { nombre: sede } });
      if (!configuracion || !isValidAppointmentSlot(fecha, hora, configuracion)) return 'horario-invalido' as const;
      const ocupado = await transaction.turno.findFirst({
        where: { fecha, hora, sede },
        select: { id: true },
      });
      if (ocupado) return null;

      return transaction.turno.create({
        data: {
          tipo,
          sede,
          fecha,
          hora,
          user: { connect: { id: duenoId } },
          mascota: { connect: { id: mascota.id } },
        },
        include: {
          mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
        },
      });
    });
    if (turno === 'horario-invalido') {
      return response.status(400).json({ message: 'El horario ya no está disponible en esta sede.' });
    }
    if (!turno) {
      return response.status(409).json({ message: 'Ese horario acaba de ser ocupado. Elige otro.' });
    }
    return response.status(201).json(turno);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ message: 'Ese horario acaba de ser ocupado. Elige otro.' });
    console.error('No se pudo agendar el turno de seguimiento:', error);
    return response
      .status(500)
      .json({ message: 'No se pudo agendar el turno de seguimiento.' });
  }
});

app.get('/api/admin/turnos', requireSession, requireAdmin, async (request, response) => {

  try {
    const turnos = await prisma.turno.findMany({
      include: {
        user: { select: { id: true, nombre: true, email: true } },
        mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
      },
      orderBy: [{ fecha: 'asc' }, { hora: 'asc' }],
    });
    return response.json(turnos);
  } catch (error) {
    console.error('No se pudieron consultar los turnos para administración:', error);
    return response.status(500).json({ message: 'No se pudieron consultar los turnos.' });
  }
});

app.patch('/api/admin/turnos/:id/llegada', requireSession, requireAdmin, async (request, response) => {
  const id = parseId(request.params.id);
  if (id === null) return response.status(400).json({ message: 'El id del turno no es válido.' });
  const ahora = new Date();
  const fecha = [ahora.getFullYear(), String(ahora.getMonth() + 1).padStart(2, '0'), String(ahora.getDate()).padStart(2, '0')].join('-');
  try {
    const resultado = await prisma.turno.updateMany({
      where: { id, fecha, llegadaEn: null, atendidoEn: null },
      data: { llegadaEn: ahora.toISOString() },
    });
    if (resultado.count === 0) return response.status(409).json({ message: 'El turno no está disponible para registrar la llegada.' });
    return response.json({ message: 'Llegada registrada.' });
  } catch (error) {
    console.error('No se pudo registrar la llegada:', error);
    return response.status(500).json({ message: 'No se pudo registrar la llegada.' });
  }
});

app.get('/api/admin/turnos-activos', requireSession, requireAdmin, async (request, response) => {

  const ahora = new Date();
  const fechaActual = [
    ahora.getFullYear(),
    String(ahora.getMonth() + 1).padStart(2, '0'),
    String(ahora.getDate()).padStart(2, '0'),
  ].join('-');

  try {
    const turnos = await prisma.turno.findMany({

      where: {
        llegadaEn: { not: null },
        atendidoEn: null,

        fecha: fechaActual,      },
      include: {
        user: { select: { id: true, nombre: true, email: true } },
        mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
      },
      orderBy: [{ llegadaEn: 'asc' }, { hora: 'asc' }, { id: 'asc' }],
    });
    return response.json(turnos);
  } catch (error) {
    console.error('No se pudieron consultar los turnos activos:', error);
    return response.status(500).json({ message: 'No se pudieron consultar los turnos activos.' });
  }
});

app.patch('/api/admin/turnos/:id/atendido', requireSession, requireAdmin, async (request, response) => {
  const id = parseId(request.params.id);
  if (id === null) return response.status(400).json({ message: 'El id del turno no es válido.' });
  const { descripcion, seguimiento, desmarcar } = request.body ?? {};
  if (desmarcar !== undefined) return response.status(400).json({ message: 'Una atención no se puede desmarcar.' });
  if (typeof descripcion !== 'string' || !descripcion.trim() || descripcion.trim().length > 500) return response.status(400).json({ message: 'Escribí una descripción de hasta 500 caracteres.' });
  if (seguimiento !== undefined && seguimiento !== null && (typeof seguimiento !== 'object' || !['Control', 'Vacunas', 'Estética'].includes(seguimiento.tipo) || typeof seguimiento.sede !== 'string' || !isValidDateOnly(seguimiento.fecha) || typeof seguimiento.hora !== 'string')) return response.status(400).json({ message: 'Los datos del seguimiento no son válidos.' });
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const actual = await tx.turno.findUnique({ where: { id } });
      if (!actual) return { error: 'no-existe' as const };
      if (actual.atendidoEn || !actual.llegadaEn) return { error: 'estado' as const };
      if (seguimiento) {
        if (seguimiento.sede !== actual.sede) return { error: 'sede' as const };
        const sede = await tx.sede.findUnique({ where: { nombre: seguimiento.sede } });
        if (!sede || !isValidAppointmentSlot(seguimiento.fecha, seguimiento.hora, sede)) return { error: 'horario' as const };
        const ocupado = await tx.turno.findFirst({ where: { sede: seguimiento.sede, fecha: seguimiento.fecha, hora: seguimiento.hora } });
        if (ocupado) return { error: 'ocupado' as const };
      }
      const actualizado = await tx.turno.updateMany({ where: { id, atendidoEn: null, llegadaEn: { not: null } }, data: { atendidoEn: new Date().toISOString(), descripcion: descripcion.trim() } });
      if (actualizado.count !== 1) return { error: 'estado' as const };
      const nuevo = seguimiento ? await tx.turno.create({ data: { tipo: seguimiento.tipo, sede: seguimiento.sede, fecha: seguimiento.fecha, hora: seguimiento.hora, userId: actual.userId, mascotaId: actual.mascotaId } }) : null;
      return { turno: await tx.turno.findUnique({ where: { id } }), seguimiento: nuevo };
    });
    if ('error' in resultado) {
      if (resultado.error === 'no-existe') return response.status(404).json({ message: 'El turno no existe.' });
      if (resultado.error === 'estado') return response.status(409).json({ message: 'El turno ya fue atendido o todavía no registró su llegada.' });
      if (resultado.error === 'ocupado') return response.status(409).json({ message: 'El horario del seguimiento ya está ocupado.' });
      return response.status(400).json({ message: 'Revisá la sede y el horario del seguimiento.' });
    }
    return response.json(resultado);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ message: 'El horario del seguimiento ya está ocupado.' });
    console.error('No se pudo completar la atención:', error);
    return response.status(500).json({ message: 'No se pudo completar la atención.' });
  }
});

app.patch('/api/admin/turnos/:id', requireSession, requireAdmin, async (request, response) => {

  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id del turno no es válido.' });
  }
  const { tipo, sede, fecha, hora } = request.body ?? {};
  const data: {
    tipo?: string;
    sede?: string;
    fecha?: string;
    hora?: string;
    recordatorioEnviadoEn?: string | null;
  } = {};

  if (tipo !== undefined) {
    if (typeof tipo !== 'string' || !['Control', 'Vacunas', 'Estética'].includes(tipo)) {
      return response.status(400).json({ message: 'El tipo de turno no es válido.' });
    }
    data.tipo = tipo;
  }
  if (sede !== undefined) {
    if (
      typeof sede !== 'string' ||
      !(await prisma.sede.findUnique({ where: { nombre: sede } }))
    ) {
      return response.status(400).json({ message: 'La sede no es válida.' });
    }
    data.sede = sede;
  }
  if (fecha !== undefined) {
    if (!isValidDateOnly(fecha)) {
      return response.status(400).json({ message: 'La fecha debe ser una fecha real en formato AAAA-MM-DD.' });
    }
    data.fecha = fecha;
  }
  if (hora !== undefined) {
    if (typeof hora !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
      return response.status(400).json({ message: 'La hora debe tener formato HH:mm.' });
    }
    data.hora = hora;
  }
  if (Object.keys(data).length === 0) {
    return response.status(400).json({ message: 'Indica el tipo, la sede, la fecha o la hora para actualizar.' });
  }

  try {
    const resultado = await prisma.$transaction(async (transaction) => {
      const anterior = await transaction.turno.findUnique({
        where: { id },
        include: { mascota: { select: { nombre: true, foto: true } } },
      });
      if (!anterior) return null;
      if (anterior.llegadaEn || anterior.atendidoEn) return { validationError: 'estado' as const };

      const cambiaHorario =
        (fecha !== undefined && fecha !== anterior.fecha) ||
        (hora !== undefined && hora !== anterior.hora);
      const cambiaDisponibilidad =
        cambiaHorario || (sede !== undefined && sede !== anterior.sede);
      const fechaDestino = fecha ?? anterior.fecha;
      const horaDestino = hora ?? anterior.hora;
      if (cambiaDisponibilidad) {
        const sedeDestino = sede ?? anterior.sede;
        const configuracion = await transaction.sede.findUnique({ where: { nombre: sedeDestino } });
        if (!configuracion || !isValidAppointmentSlot(fechaDestino, horaDestino, configuracion)) return { validationError: 'invalid' as const };
        const ocupado = await transaction.turno.findFirst({
          where: { id: { not: id }, fecha: fechaDestino, hora: horaDestino, sede: sedeDestino },
          select: { id: true },
        });
        if (ocupado) return { validationError: 'occupied' as const };
      }
      if (cambiaHorario) {
        data.recordatorioEnviadoEn = null;
      }

      const turno = await transaction.turno.update({
        where: { id },
        data,
        include: {
          user: { select: { id: true, nombre: true, email: true } },
          mascota: { select: { id: true, nombre: true, especie: true, raza: true, foto: true } },
        },
      });
      const cambios = [
        anterior.tipo !== turno.tipo ? `tipo: ${anterior.tipo} → ${turno.tipo}` : null,
        anterior.sede !== turno.sede ? `sede: ${anterior.sede} → ${turno.sede}` : null,
        anterior.fecha !== turno.fecha ? `fecha: ${anterior.fecha} → ${turno.fecha}` : null,
        anterior.hora !== turno.hora ? `hora: ${anterior.hora} → ${turno.hora}` : null,
      ].filter((cambio): cambio is string => cambio !== null);

      const notification = cambios.length
        ? await transaction.notification.create({
            data: {
              userId: turno.userId,
              turnoId: turno.id,
              mascotaNombre: anterior.mascota.nombre,
              mascotaFoto: anterior.mascota.foto,
              title: 'Tu turno fue modificado',
              message: `El turno de ${anterior.mascota.nombre} cambió: ${cambios.join(', ')}.`,
            },
          })
        : null;

      if (notification) await limitarNotificaciones(transaction, turno.userId);
      return { turno, notification };
    });
    if (!resultado) {
      return response.status(404).json({ message: 'No se encontró el turno.' });
    }
    if ('validationError' in resultado) {
      if (resultado.validationError === 'estado') return response.status(409).json({ message: 'El turno ya registró su llegada o fue atendido.' });
      if (resultado.validationError === 'occupied') {
        return response.status(409).json({ message: 'Ese horario ya está ocupado. Elige otro.' });
      }
      return response.status(400).json({
        message: 'Elegí una fecha y un horario futuros dentro de la atención de la sede.',
      });
    }

    return response.json({
      ...resultado.turno,
      notificationCreated: resultado.notification !== null,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ message: 'Ese horario ya está ocupado.' });
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontró el turno.' });
    }
    console.error('No se pudo modificar el turno:', error);
    return response.status(500).json({ message: 'No se pudo modificar el turno.' });
  }
});

app.delete('/api/admin/turnos/:id/registro', requireSession, requireAdmin, async (request, response) => {
  const id = parseId(request.params.id);
  if (id === null) return response.status(400).json({ message: 'El id del turno no es válido.' });
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const turno = await tx.turno.findUnique({ where: { id }, include: { mascota: { select: { nombre: true, foto: true } } } });
      if (!turno) return 'no-existe';
      if (!turno.atendidoEn) return 'no-atendido';
      await tx.notification.updateMany({ where: { turnoId: id, mascotaNombre: null }, data: { mascotaNombre: turno.mascota.nombre, mascotaFoto: turno.mascota.foto } });
      await tx.notification.updateMany({ where: { turnoId: id, sede: null }, data: { sede: turno.sede } });
      await tx.notification.updateMany({ where: { turnoId: id, hora: null }, data: { hora: turno.hora } });
      const eliminado = await tx.turno.deleteMany({ where: { id, atendidoEn: { not: null } } });
      if (eliminado.count === 0) throw new Error('El turno cambió mientras se eliminaba.');
      return 'eliminado';
    });
    if (resultado === 'no-existe') return response.status(404).json({ message: 'No se encontró el turno.' });
    if (resultado === 'no-atendido') return response.status(409).json({ message: 'Solo se pueden eliminar registros de turnos atendidos.' });
    return response.json({ eliminado: true });
  } catch (error) {
    console.error('No se pudo eliminar el registro:', error);
    return response.status(500).json({ message: 'No se pudo eliminar el registro.' });
  }
});

app.delete('/api/admin/turnos/:id', requireSession, requireAdmin, async (request, response) => {

  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id del turno no es válido.' });
  }

  const motivoPedido =
    typeof request.body?.motivo === 'string' ? request.body.motivo.trim() : '';
  const motivo =
    motivoPedido !== ''
      ? motivoPedido
      : 'La veterinaria no pudo sostener la atención en ese horario.';

  try {
    const resultado = await prisma.$transaction(async (transaction) => {
      const turno = await transaction.turno.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, nombre: true } },
          mascota: { select: { nombre: true, foto: true } },
        },
      });
      if (!turno) return null;
      if (turno.atendidoEn) {
        return { blocked: 'atendido' as const };
      }
      if (turno.llegadaEn) {
        return { blocked: 'llegada' as const };
      }

      // Conserva los datos del turno en el aviso antes de eliminarlo.
      const notification = await transaction.notification.create({
        data: {
          userId: turno.userId,
          mascotaNombre: turno.mascota.nombre,
          mascotaFoto: turno.mascota.foto,
          sede: turno.sede,
          hora: turno.hora,
          motivo,
          title: 'Tu turno fue cancelado',
          message: `El turno de ${turno.mascota.nombre} del ${formatearFechaLarga(turno.fecha)} a las ${turno.hora} fue cancelado.`,
        },
      });

      await transaction.turno.delete({ where: { id } });
      await limitarNotificaciones(transaction, turno.userId);

      return { turno, notification };
    });

    if (!resultado) {
      return response.status(404).json({ message: 'No se encontró el turno.' });
    }
    if ('blocked' in resultado) {
      return response.status(409).json({
        message:
          resultado.blocked === 'atendido'
            ? 'Ese turno ya fue atendido, no se puede cancelar.'
            : 'Ese paciente ya se presentó, no se puede cancelar.',
      });
    }

    return response.json({
      id: resultado.turno.id,
      cancelado: true,
      notificationCreated: true,
    });
  } catch (error) {
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontró el turno.' });
    }
    console.error('No se pudo cancelar el turno:', error);
    return response.status(500).json({ message: 'No se pudo cancelar el turno.' });
  }
});

app.post('/api/notifications/reminders', requireSession, async (request, response) => {
  const user = request.user;
  try {
    if (user.role !== 'ADMIN') await createUpcomingAppointmentReminders(user.id);
    return response.status(204).send();
  } catch (error) {
    console.error('No se pudieron generar los recordatorios:', error);
    return response.status(500).json({ message: 'No se pudieron generar los recordatorios.' });
  }
});

app.get('/api/notifications', requireSession, async (request, response) => {
  const user = request.user;

  try {
    await prisma.$transaction((tx) => limitarNotificaciones(tx, user.id));
  } catch (error) {
    console.error('No se pudieron limpiar las notificaciones:', error);
    return response.status(500).json({ message: 'No se pudieron cargar las notificaciones.' });
  }

  const where = {
    userId: user.id,
    ...(user.role === 'ADMIN' ? { title: { not: TITULO_RECORDATORIO_TURNO } } : {}),
  };

  try {
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },

        include: {
          turno: {
            select: {
              sede: true,
              tipo: true,
              fecha: true,
              hora: true,
              mascota: { select: { nombre: true, foto: true } },
            },
          },
        },
      }),
      prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);

    const conMascota = items.map((item) => ({
      ...item,
      mascota:
        item.turno?.mascota ??
        (item.mascotaNombre
          ? { nombre: item.mascotaNombre, foto: item.mascotaFoto ?? null }
          : null),
    }));

    return response.json({ items: conMascota, unreadCount });
  } catch (error) {
    console.error('No se pudieron consultar las notificaciones:', error);
    return response.status(500).json({ message: 'No se pudieron consultar las notificaciones.' });
  }
});

app.post('/api/notifications/global', requireSession, requireAdmin, async (request, response) => {

  const { title, message } = request.body ?? {};
  if (typeof title !== 'string' || title.trim().length < 4 || title.trim().length > 60) {
    return response
      .status(400)
      .json({ message: 'El título tiene que tener entre 4 y 60 caracteres.' });
  }
  if (typeof message !== 'string' || message.trim().length < 4 || message.trim().length > 240) {
    return response
      .status(400)
      .json({ message: 'La descripción tiene que tener entre 4 y 240 caracteres.' });
  }

  try {

    const usuarios = await prisma.usuario.findMany({ select: { id: true } });
    const creados = await prisma.$transaction(async (tx) => {
      const resultado = await tx.notification.createMany({ data: usuarios.map((usuario) => ({
        userId: usuario.id, title: title.trim(), message: message.trim(), esGlobal: true,
      })) });
      for (const usuario of usuarios) await limitarNotificaciones(tx, usuario.id);
      return resultado;
    });

    return response.status(201).json({ creadas: creados.count });
  } catch (error) {
    console.error('No se pudo enviar la notificación global:', error);
    return response
      .status(500)
      .json({ message: 'No se pudo enviar la notificación a todos los clientes.' });
  }
});

app.patch('/api/notifications/:id/read', requireSession, async (request, response) => {
  const user = request.user;
  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id de la notificación no es válido.' });
  }

  try {
    const result = await prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: new Date().toISOString() },
    });
    if (result.count === 0) {
      const notification = await prisma.notification.findFirst({
        where: { id, userId: user.id },
      });
      if (!notification) {
        return response.status(404).json({ message: 'No se encontró la notificación.' });
      }
      return response.json(notification);
    }
    const notification = await prisma.notification.findUnique({ where: { id } });
    return response.json(notification);
  } catch (error) {
    console.error('No se pudo marcar la notificación como leída:', error);
    return response.status(500).json({ message: 'No se pudo actualizar la notificación.' });
  }
});

app.post('/api/users', async (request, response) => {
  const { nombre, email, password, telefono } = request.body ?? {};

  if (
    typeof nombre !== 'string' ||
    typeof email !== 'string' ||
    !validPassword(password) ||
    typeof telefono !== 'string' ||
    !nombre.trim() ||
    !/^\S+@\S+\.\S+$/.test(email.trim()) ||
    !telefono.trim()
  ) {
    return response.status(400).json({ message: 'Revisa el nombre, el correo y la contraseña.' });
  }

  try {
    const user = await prisma.usuario.create({
      data: {
        nombre: nombre.trim(),
        email: email.trim().toLowerCase(),
        passwordHash: await hashPassword(password),
        telefono: telefono.trim(),
      },
      select: { id: true, nombre: true, email: true, telefono: true, createdAt: true },
    });
    return response.status(201).json(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return response.status(409).json({ message: 'Ese correo ya esta registrado.' });
    }
    console.error('No se pudo registrar el usuario:', error);
    return response.status(500).json({ message: 'No se pudo crear la cuenta.' });
  }
});

app.get('/api/admin/users', requireSession, requireAdmin, async (request, response) => {

  try {
    const users = await prisma.usuario.findMany({
      select: {
        id: true,
        nombre: true,
        email: true,
        role: true,
        telefono: true,
        createdAt: true,
      },
      orderBy: { id: 'asc' },
    });
    return response.json(users);
  } catch (error) {
    console.error('No se pudieron consultar los usuarios para administración:', error);
    return response.status(500).json({ message: 'No se pudieron consultar los usuarios.' });
  }
});

app.post('/api/admin/users', requireSession, requireAdmin, async (request, response) => {

  const { nombre, email, telefono } = request.body ?? {};
  if (
    typeof nombre !== 'string' ||
    typeof email !== 'string' ||
    typeof telefono !== 'string' ||
    !nombre.trim() ||
    !/^\S+@\S+\.\S+$/.test(email.trim()) ||
    !telefono.trim()
  ) {
    return response.status(400).json({ message: 'Revisa los datos y el rol del usuario.' });
  }

  try {
    const password = temporaryPassword();
    const user = await prisma.usuario.create({
      data: {
        nombre: nombre.trim(),
        email: email.trim().toLowerCase(),
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        telefono: telefono.trim(),
        role: 'ADMIN',
      },
      select: { id: true, nombre: true, email: true, role: true, telefono: true },
    });
    return response.status(201).json({ ...user, temporaryPassword: password });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return response.status(409).json({ message: 'Ese correo ya está registrado.' });
    }
    console.error('No se pudo crear el usuario desde administración:', error);
    return response.status(500).json({ message: 'No se pudo crear el usuario.' });
  }
});

app.delete('/api/admin/users/:id', requireSession, requireAdmin, async (request, response) => {
  const adminId = request.user.id;

  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id de usuario no es válido.' });
  }
  if (id === adminId) {
    return response.status(400).json({ message: 'No puedes eliminar tu propia cuenta.' });
  }

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const target = await tx.usuario.findUnique({ where: { id }, select: { role: true, email: true } });
      if (!target) return 'no-existe';
      if (target.role === 'ADMIN' && (await tx.usuario.count({ where: { role: 'ADMIN' } })) <= 1) return 'ultimo-admin';
      await tx.notification.updateMany({ where: { tipo: 'recuperacion', solicitanteEmail: target.email }, data: { tipo: 'recuperacion-resuelta', readAt: new Date().toISOString() } });
      await tx.usuario.delete({ where: { id } });
      return 'eliminado';
    });
    if (resultado === 'no-existe') {
      return response.status(404).json({ message: 'No se encontró el usuario.' });
    }
    if (resultado === 'ultimo-admin') {
      return response.status(400).json({ message: 'No se puede eliminar al último administrador.' });
    }
    return response.status(204).send();
  } catch (error) {
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontró el usuario.' });
    }
    console.error('No se pudo eliminar el usuario:', error);
    return response.status(500).json({ message: 'No se pudo eliminar el usuario.' });
  }
});

app.delete('/api/users/:id', requireSession, async (request, response) => {
  const usuario = request.user;
  const id = parseId(request.params.id);
  if (id === null) return response.status(400).json({ message: 'El id no es válido.' });
  if (id !== usuario.id) return response.status(403).json({ message: 'Solo puedes eliminar tu propia cuenta.' });
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const actual = await tx.usuario.findUnique({ where: { id } });
      if (!actual) return 'no-existe';
      if (actual.role === 'ADMIN' && (await tx.usuario.count({ where: { role: 'ADMIN' } })) <= 1) return 'ultimo-admin';
      await tx.notification.updateMany({ where: { tipo: 'recuperacion', solicitanteEmail: actual.email }, data: { tipo: 'recuperacion-resuelta', readAt: new Date().toISOString() } });
      await tx.usuario.delete({ where: { id } });
      return 'eliminado';
    });
    if (resultado === 'no-existe') return response.status(404).json({ message: 'No se encontró el usuario.' });
    if (resultado === 'ultimo-admin') return response.status(409).json({ message: 'No se puede eliminar al último administrador.' });
    return response.status(204).send();
  } catch (error) {
    console.error('No se pudo eliminar la cuenta:', error);
    return response.status(500).json({ message: 'No se pudo eliminar la cuenta.' });
  }
});

app.get('/api/users/:id', requireSession, async (request, response) => {
  const autenticado = request.user;
  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id de usuario no es valido.' });
  }
  if (id !== autenticado.id) return response.status(403).json({ message: 'Solo puedes acceder a tu propio perfil.' });

  try {
    const user = await prisma.usuario.findUnique({
      where: { id },
      select: { id: true, nombre: true, email: true, telefono: true },
    });
    if (!user) {
      return response.status(404).json({ message: 'No se encontro el usuario.' });
    }
    return response.json(user);
  } catch (error) {
    console.error('No se pudo consultar el perfil:', error);
    return response.status(500).json({ message: 'No se pudo consultar el perfil.' });
  }
});

app.patch('/api/users/:id', requireSession, async (request, response) => {
  const autenticado = request.user;
  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id de usuario no es valido.' });
  }
  if (id !== autenticado.id) return response.status(403).json({ message: 'Solo puedes acceder a tu propio perfil.' });

  const body = request.body ?? {};
  if (typeof body === 'object' && body !== null && 'email' in body) {
    return response.status(400).json({ message: 'El correo electrónico no se puede modificar.' });
  }
  const { nombre, telefono } = body;
  const data: {
    nombre?: string;
    telefono?: string | null;
  } = {};

  if (nombre !== undefined) {
    if (typeof nombre !== 'string' || !nombre.trim()) {
      return response.status(400).json({ message: 'El nombre no es valido.' });
    }
    data.nombre = nombre.trim();
  }
  if (telefono !== undefined) {
    if (typeof telefono !== 'string' || !telefono.trim()) {
      return response.status(400).json({ message: 'El telefono es obligatorio.' });
    }
    data.telefono = telefono.trim();
  }
  if (Object.keys(data).length === 0) {
    return response.status(400).json({ message: 'No hay datos de perfil para actualizar.' });
  }
  if (telefono === undefined) {
    return response.status(400).json({ message: 'El telefono es obligatorio.' });
  }

  try {
    const user = await prisma.usuario.update({
      where: { id },
      data,
      select: { id: true, nombre: true, email: true, telefono: true },
    });
    return response.json(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return response.status(409).json({ message: 'Ese correo ya esta registrado.' });
      }
      if (error.code === 'P2025') {
        return response.status(404).json({ message: 'No se encontro el usuario.' });
      }
    }
    console.error('No se pudo actualizar el perfil:', error);
    return response.status(500).json({ message: 'No se pudo actualizar el perfil.' });
  }
});

app.patch('/api/users/:id/password', requireSession, async (request, response) => {
  const user = request.user;

  const id = parseId(request.params.id);
  if (id === null) {
    return response.status(400).json({ message: 'El id de usuario no es válido.' });
  }
  if (user.id !== id) {
    return response.status(403).json({ message: 'Solo puedes cambiar tu propia contraseña.' });
  }

  const { currentPassword, newPassword } = request.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return response.status(400).json({ message: 'Completa la contraseña actual y la nueva.' });
  }
  if (!validPassword(newPassword)) {
    return response.status(400).json({
      message: 'La nueva contraseña debe tener entre 8 y 128 caracteres.',
    });
  }

  try {
    const account = await prisma.usuario.findUnique({
      where: { id },
      select: { id: true, nombre: true, email: true, telefono: true, passwordHash: true, sessionVersion: true },
    });
    if (!account || !(await verifyPassword(account.passwordHash, currentPassword))) {
      return response.status(400).json({ message: 'La contraseña actual no es correcta.' });
    }
    if (await verifyPassword(account.passwordHash, newPassword)) {
      return response.status(400).json({ message: 'La nueva contraseña debe ser diferente.' });
    }

    const updated = await prisma.usuario.update({
      where: { id, sessionVersion: user.sessionVersion, passwordHash: account.passwordHash },
      data: { passwordHash: await hashPassword(newPassword), sessionVersion: { increment: 1 }, mustChangePassword: false },
      select: { id: true, nombre: true, email: true, telefono: true, passwordHash: true, sessionVersion: true },
    });
    return response.json({
      id: updated.id,
      nombre: updated.nombre,
      email: updated.email,
      telefono: updated.telefono,
      accessToken: createAccessToken(updated),
      mustChangePassword: false,
    });
  } catch (error) {
    if (isMissingRecord(error)) {
      return response.status(404).json({ message: 'No se encontró el usuario.' });
    }
    console.error('No se pudo cambiar la contraseña:', error);
    return response.status(500).json({ message: 'No se pudo cambiar la contraseña.' });
  }
});

app.post('/api/password-reset/request', async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  if (!/^\S+@\S+\.\S+$/.test(email)) return response.status(400).json({ message: 'Escribí un correo válido.' });
  try {
    await prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.findUnique({ where: { email } });
      if (!usuario) return;
      const admins = await tx.usuario.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
      for (const admin of admins) {

        // Una solicitud leída todavía puede estar pendiente.
        const pendiente = await tx.notification.findFirst({ where: { userId: admin.id, tipo: 'recuperacion', solicitanteEmail: email } });
        if (!pendiente) {
          await tx.notification.create({ data: {
            userId: admin.id, tipo: 'recuperacion', solicitanteEmail: email,
            title: 'Recuperación de contraseña', message: usuario.nombre,
          } });
          await limitarNotificaciones(tx, admin.id);
        }
      }
    });
    return response.json({ message: 'Si el correo está registrado, la veterinaria recibirá la solicitud.' });
  } catch (error) {
    console.error('No se pudo solicitar la recuperación:', error);
    return response.status(500).json({ message: 'No se pudo enviar la solicitud.' });
  }
});

app.post('/api/admin/password-reset', requireSession, requireAdmin, async (request, response) => {
  const adminId = request.user.id;
  const { userId, solicitudId } = request.body ?? {};
  const desdeSolicitud = solicitudId !== undefined;
  const id = desdeSolicitud ? solicitudId : userId;
  if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ message: 'Indica el usuario o la solicitud a restablecer.' });
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const solicitud = desdeSolicitud ? await tx.notification.findFirst({ where: { id: solicitudId, userId: adminId } }) : null;
      if (desdeSolicitud && (!solicitud || solicitud.tipo !== 'recuperacion' || !solicitud.solicitanteEmail)) return { error: 'solicitud' as const };
      const usuario = await tx.usuario.findUnique({ where: desdeSolicitud ? { email: solicitud!.solicitanteEmail! } : { id: userId } });
      if (!usuario) return { error: 'usuario' as const };
      const password = temporaryPassword();
      await tx.usuario.update({ where: { id: usuario.id }, data: { passwordHash: await hashPassword(password), sessionVersion: { increment: 1 }, mustChangePassword: true } });

      await tx.notification.updateMany({
        where: { tipo: 'recuperacion', solicitanteEmail: usuario.email },
        data: { tipo: 'recuperacion-resuelta', readAt: new Date().toISOString() },
      });
      return { id: usuario.id, nombre: usuario.nombre, email: usuario.email, password };
    });
    if ('error' in resultado) return response.status(resultado.error === 'usuario' ? 404 : 409).json({ message: resultado.error === 'usuario' ? 'No se encontró el usuario.' : 'La solicitud ya fue resuelta o no está disponible.' });
    return response.json(resultado);
  } catch (error) {
    console.error('No se pudo restablecer la contraseña:', error);
    return response.status(500).json({ message: 'No se pudo restablecer la contraseña.' });
  }
});

app.post('/api/sessions', async (request, response) => {
  const { email, password } = request.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password || password.length > 128) {
    return response.status(400).json({ message: 'Ingresa tu correo y contraseña.' });
  }

  try {
    const user = await prisma.usuario.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    if (!user) {

      return response.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    }

    if (!(await verifyPassword(user.passwordHash, password))) {

      return response.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    }

    const accessToken = createAccessToken(user);

    return response.status(200).json({
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      telefono: user.telefono,
      esAdmin: user.role === 'ADMIN',
      accessToken,
      mustChangePassword: user.mustChangePassword,
    });
  } catch (error) {
    console.error('No se pudo iniciar sesion:', error);
    return response.status(500).json({ message: 'No se pudo iniciar sesion.' });
  }
});

app.delete('/api/sessions', requireSession, async (request, response) => {
  await prisma.usuario.updateMany({
    where: { id: request.user.id, sessionVersion: request.user.sessionVersion },
    data: { sessionVersion: { increment: 1 } },
  });
  return response.status(204).send();
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : 500;
  if (status === 400 || status === 413) {
    response.status(status).json({ message: status === 413 ? 'La solicitud es demasiado grande.' : 'El cuerpo JSON no es válido.' });
    return;
  }
  console.error('Error inesperado en la API:', error);
  response.status(500).json({ message: 'No se pudo completar la solicitud.' });
});

export async function start(): Promise<void> {
  await initDatabase();
  await prisma.$connect();
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`API escuchando en http://0.0.0.0:${port}`);
      resolve();
    });
    server.once('error', reject);
  });
}

if (require.main === module) {
  start().catch(async (error: unknown) => {
    console.error('No se pudo iniciar la API:', error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
}

export { app, prisma };
