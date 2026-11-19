const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');
const mysql = require('mysql2');

const app = express();
app.use(express.json());
app.use(cors());

// Inicializar el cliente de OpenAI apuntando a la baseURL de OpenRouter
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tu-sitio-web.com', // Opcional: para rankings en OpenRouter
    'X-Title': 'Mi Aplicativo Web',              // Opcional: nombre de tu app
  },
});

const MODELO = 'openai/gpt-4o-mini'; // Puedes cambiarlo por cualquier modelo soportado por OpenRouter
const MAX_FILAS = 50;
const MAX_VUELTAS_HERRAMIENTAS = 5;

// ---------------------------------------------------------------------------
// 1. Conexión a MariaDB (XAMPP) con un pool de conexiones
// ---------------------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sakila',
  connectionLimit: 5,
  dateStrings: true, // fechas como texto para que el JSON sea legible
});

// Cada conexión nueva queda en modo solo lectura (segunda capa de protección)
pool.on('connection', (conexion) => {
  conexion.query('SET SESSION TRANSACTION READ ONLY');
});

const db = pool.promise();

// ---------------------------------------------------------------------------
// 2. Esquema de la base en caché (se consulta una sola vez)
// ---------------------------------------------------------------------------
let esquemaPromesa = null;

function obtenerEsquema() {
  if (!esquemaPromesa) {
    esquemaPromesa = db
      .query(
        `SELECT c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.COLUMN_TYPE
           FROM INFORMATION_SCHEMA.COLUMNS c
           JOIN INFORMATION_SCHEMA.TABLES t
             ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
          WHERE c.TABLE_SCHEMA = DATABASE()
          ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
      )
      .then(([filas]) => {
        const tablas = {};
        for (const f of filas) {
          const clave = f.TABLE_TYPE === 'VIEW' ? `${f.TABLE_NAME} (vista)` : f.TABLE_NAME;
          (tablas[clave] ||= []).push(`${f.COLUMN_NAME} ${f.COLUMN_TYPE}`);
        }
        return Object.entries(tablas)
          .map(([tabla, columnas]) => `- ${tabla}: ${columnas.join(', ')}`)
          .join('\n');
      })
      .catch((error) => {
        esquemaPromesa = null; // si falla (p. ej. MariaDB apagado), se reintenta en la siguiente petición
        throw error;
      });
  }
  return esquemaPromesa;
}

// ---------------------------------------------------------------------------
// 3. Definición de la herramienta que el modelo puede llamar
// ---------------------------------------------------------------------------
const herramientas = [
  {
    type: 'function',
    function: {
      name: 'consultar_sakila',
      description:
        'Ejecuta una consulta SELECT de solo lectura en la base de datos sakila (MariaDB) ' +
        `y devuelve las filas en JSON (máximo ${MAX_FILAS}).`,
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'Una sola sentencia SELECT válida para MariaDB, sin punto y coma ni comentarios.',
          },
        },
        required: ['sql'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// 4. Validación estricta: solo se permite un SELECT
// ---------------------------------------------------------------------------
const PALABRAS_PROHIBIDAS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|DO|HANDLER|LOAD|SET|INTO|OUTFILE|DUMPFILE|PREPARE|EXECUTE|DEALLOCATE|SLEEP|BENCHMARK|LOAD_FILE|SHUTDOWN|KILL)\b/i;

function validarSelect(sqlOriginal) {
  if (typeof sqlOriginal !== 'string' || !sqlOriginal.trim()) {
    throw new Error('La consulta está vacía.');
  }

  // Se tolera un único ";" al final; cualquier otro indica varias sentencias
  const sql = sqlOriginal.trim().replace(/;\s*$/, '');

  if (!/^SELECT\b/i.test(sql)) throw new Error('Solo se permiten consultas que empiecen con SELECT.');
  if (sql.includes(';')) throw new Error('No se permiten varias sentencias (;).');
  if (/--|\/\*|\*\/|#/.test(sql)) throw new Error('No se permiten comentarios SQL (--, /* */, #).');

  const prohibida = sql.match(PALABRAS_PROHIBIDAS);
  if (prohibida) throw new Error(`Palabra no permitida en la consulta: ${prohibida[1].toUpperCase()}.`);

  // Limitar el resultado a MAX_FILAS: se ajusta el LIMIT final o se agrega uno
  const limiteFinal = /\bLIMIT\s+(\d+)(?:\s*(?:,|OFFSET)\s*(\d+))?\s*$/i;
  const coincidencia = sql.match(limiteFinal);
  if (!coincidencia) return `${sql} LIMIT ${MAX_FILAS}`;

  return sql.replace(limiteFinal, (texto, a, b) => {
    // "LIMIT n" | "LIMIT offset, n" | "LIMIT n OFFSET offset"
    if (b === undefined) return `LIMIT ${Math.min(Number(a), MAX_FILAS)}`;
    if (/,/.test(texto)) return `LIMIT ${a}, ${Math.min(Number(b), MAX_FILAS)}`;
    return `LIMIT ${Math.min(Number(a), MAX_FILAS)} OFFSET ${b}`;
  });
}

async function ejecutarSelectSeguro(sql) {
  const sqlSeguro = validarSelect(sql);
  console.log('[consultar_sakila]', sqlSeguro);
  const [filas] = await db.query({ sql: sqlSeguro, timeout: 10000 });
  return { filas: filas.slice(0, MAX_FILAS), total_devuelto: Math.min(filas.length, MAX_FILAS) };
}

// ---------------------------------------------------------------------------
// 5. Ciclo de respuesta: pregunta -> el modelo pide SQL -> datos reales -> respuesta
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const esquema = await obtenerEsquema();

    const messages = [
      {
        role: 'system',
        content:
          'Eres un asistente que responde en español sobre la base de datos sakila (MariaDB), ' +
          'una tienda de renta de películas. Cuando la pregunta necesite datos, usa la herramienta ' +
          'consultar_sakila con una sola consulta SELECT; nunca inventes datos. Usa JOIN para traer ' +
          'nombres y cifras en la misma consulta (no los combines tú a partir de consultas separadas) ' +
          'y respeta el orden de las filas devueltas. Si una consulta falla, ' +
          `corrígela y vuelve a intentar. Los resultados llegan limitados a ${MAX_FILAS} filas.\n\n` +
          `Esquema de sakila:\n${esquema}`,
      },
      ...(history || []),
      { role: 'user', content: message },
    ];

    for (let vuelta = 0; vuelta < MAX_VUELTAS_HERRAMIENTAS; vuelta++) {
      const completion = await openrouter.chat.completions.create({
        model: MODELO,
        messages,
        tools: herramientas,
      });

      const respuesta = completion.choices[0].message;

      // Sin llamadas a herramientas: es la respuesta final para el chat
      if (!respuesta.tool_calls || respuesta.tool_calls.length === 0) {
        return res.json({ reply: respuesta.content });
      }

      // El modelo pidió ejecutar una o más consultas
      messages.push(respuesta);
      for (const llamada of respuesta.tool_calls) {
        let resultado;
        try {
          if (llamada.function.name !== 'consultar_sakila') {
            throw new Error(`Herramienta desconocida: ${llamada.function.name}`);
          }
          const { sql } = JSON.parse(llamada.function.arguments || '{}');
          resultado = await ejecutarSelectSeguro(sql);
        } catch (error) {
          resultado = { error: error.message };
        }
        messages.push({
          role: 'tool',
          tool_call_id: llamada.id,
          content: JSON.stringify(resultado),
        });
      }
    }

    res.json({ reply: 'No pude completar la consulta después de varios intentos. Intenta reformular tu pregunta.' });
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    const detalle =
      error.code === 'ECONNREFUSED'
        ? 'No hay conexión con MariaDB. Enciende MySQL en el panel de XAMPP.'
        : 'Error interno al procesar la solicitud con la IA';
    res.status(500).json({ error: detalle });
  }
});

// Solo se inicia el servidor al ejecutar "node server.js" (permite probar validarSelect por separado)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
  });
}

module.exports = { validarSelect };
