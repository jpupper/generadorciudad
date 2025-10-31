const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Configuración
const hostname = '0.0.0.0';
const port =  3344;

// Estado del mundo
// players: socketId -> { name, color, position: {x,y,z}, rotation: {y} }
const players = new Map();
// objects: [{ id, shape, position: {x,y,z}, rotation: {x,y,z}, size, color, alpha }]
const objects = [];
let nextObjectId = 1;

// Utilidades
function hashColorFromId(id) {
  // Genera un color HSL estable a partir del socket.id
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function snapToGrid(p, grid = 0.5) {
  return {
    x: Math.round(p.x / grid) * grid,
    y: Math.round(p.y / grid) * grid,
    z: Math.round(p.z / grid) * grid,
  };
}

// Generación de mini ciudad
function generateMiniCity() {
  const newObjects = [];
  const size = 1;
  const extent = 12; // medio tamaño de ciudad desde el origen
  const roadEvery = 4;
  for (let x = -extent; x <= extent; x++) {
    for (let z = -extent; z <= extent; z++) {
      // Carreteras en cada N filas/columnas
      if (x % roadEvery === 0 || z % roadEvery === 0) {
        newObjects.push({
          shape: 'cube',
          position: { x, y: 0.5, z },
          rotation: { x: 0, y: 0, z: 0 },
          size,
          color: '#2b2b2b',
          alpha: 1,
        });
        continue;
      }

      // Parcelas con edificios footprint 1x1 o 2x2
      const footprint = (Math.random() < 0.6) ? 2 : 1;
      const height = Math.floor(3 + Math.random() * 6);
      for (let fx = 0; fx < footprint; fx++) {
        for (let fz = 0; fz < footprint; fz++) {
          for (let y = 0; y < height; y++) {
            const isWindow = y > 0 && (y % 2 === 1) && (fx === 0 || fx === footprint - 1 || fz === 0 || fz === footprint - 1) && (Math.random() < 0.5);
            newObjects.push({
              shape: 'cube',
              position: { x: x + fx, y: 0.5 + y, z: z + fz },
              rotation: { x: 0, y: 0, z: 0 },
              size,
              color: isWindow ? '#a0c8ff' : '#808080',
              alpha: isWindow ? 0.5 : 1,
            });
          }
        }
      }

      // Saltar celdas ocupadas por footprint extra
      if (footprint === 2) {
        z += 1; // evitar solapado simple en z
      }
    }
    // avance normal de x
  }
  return newObjects;
}

// Servidor HTTP y estáticos
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint simple para salud
app.get('/health', (req, res) => {
  res.json({ ok: true, players: players.size, objects: objects.length });
});

const server = http.createServer(app);
const SOCKET_PATH = '/socket.io';
const io = new Server(server, {
  path: SOCKET_PATH,
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Instrumentación desactivada

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id, 'pid:', process.pid);
  // Instrumentación de handshake y trace desactivada

  // Registro inicial con nombre (con ACK opcional)
  socket.on('register', (data, ack) => {
    const name = (data && typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : 'Anónimo';
    const color = hashColorFromId(socket.id);
    const player = {
      name,
      color,
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { y: 0 },
    };
    players.set(socket.id, player);

    // Enviar estado inicial al nuevo cliente
    const playersArray = Array.from(players.entries()).map(([id, p]) => ({ id, ...p }));
    socket.emit('init_state', { players: playersArray, objects });

    // ACK al cliente si lo pidió
    if (typeof ack === 'function') {
      try { ack({ ok: true, name, playerCount: players.size }); } catch (e) {}
    }

    // Anunciar a los demás que este jugador se unió
    socket.broadcast.emit('player_joined', { id: socket.id, ...player });
    // Jugador registrado
  });

  // Actualización de posición/rotación del jugador
  socket.on('player_move', (data) => {
    const p = players.get(socket.id);
    if (!p) return;

    if (data && data.position) {
      const { x, y, z } = data.position;
      // Limitar Y al suelo mínimo
      p.position = { x: Number(x) || 0, y: Math.max(0.5, Number(y) || 0.5), z: Number(z) || 0 };
    }
    if (data && data.rotation) {
      const { y } = data.rotation;
      p.rotation = { y: Number(y) || 0 };
    }

    // Reenviar a otros
    socket.broadcast.emit('player_moved', { id: socket.id, position: p.position, rotation: p.rotation });
  });

  // Colocar objetos
  socket.on('place_object', (data) => {
    const shape = (data && data.shape) || 'cube';
    const size = (data && Number(data.size)) || 1;
    const color = (data && data.color) || '#cccccc';
    const alpha = (data && typeof data.alpha === 'number') ? Math.max(0, Math.min(1, data.alpha)) : 1;
    let position = (data && data.position) || { x: 0, y: 0.5, z: 0 };
    let rotation = (data && data.rotation) || { x: 0, y: 0, z: 0 };

    // Snap a la grilla con medias unidades para permitir subdivisiones (ej. 1x1 en 2x2)
    position = snapToGrid(position, 0.5);

    // Altura mínima sobre el suelo
    position.y = Math.max(0.5, position.y);

    const object = {
      id: nextObjectId++,
      shape,
      position,
      rotation,
      size,
      color,
      alpha,
    };
    objects.push(object);

    // Difundir a todos (incluyendo al emisor)
    io.emit('object_placed', object);
    // Objeto colocado
  });

  // Eliminar objeto por id
  socket.on('remove_object', ({ id }) => {
    const objId = Number(id);
    const idx = objects.findIndex(o => o.id === objId);
    if (idx !== -1) {
      objects.splice(idx, 1);
      io.emit('object_removed', { id: objId });
    }
  });

  // Generar mini ciudad: añadir sin borrar, evitar solapados
  socket.on('generate_city', () => {
    const generated = generateMiniCity();
    const occupied = new Set(objects.map(o => `${o.position.x},${o.position.y},${o.position.z}`));
    const added = [];
    for (const o of generated) {
      const key = `${o.position.x},${o.position.y},${o.position.z}`;
      if (occupied.has(key)) continue;
      o.id = nextObjectId++;
      objects.push(o);
      occupied.add(key);
      added.push(o);
    }
    // Difundir solo los nuevos objetos
    for (const o of added) io.emit('object_placed', o);
  });

  socket.on('disconnect', () => {
    // Cliente desconectado
    if (players.has(socket.id)) {
      players.delete(socket.id);
      socket.broadcast.emit('player_disconnected', { id: socket.id });
    }
  });
});

// Heartbeat desactivado

server.listen(port, hostname, () => {
  console.log(`Server running at http://localhost:${port}/`);
  console.log(`Server running at http://${hostname}:${port}/`);
  console.log(`Static files: ${path.join(__dirname, 'public')}`);
});