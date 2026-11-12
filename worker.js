// ═══════════════════════════════════════════════════════════════════════════
//  IRONQx · Cloudflare Worker — Form → Resend Email
//  Pegar completo en el editor de Cloudflare Workers
//  Variable de entorno requerida: RESEND_API_KEY  (tipo Secret)
// ═══════════════════════════════════════════════════════════════════════════

const TO_EMAIL   = "ironqx.coach@gmail.com";   // ← tu email
const FROM_EMAIL = "formulario@ironqx.fit"; // ← debe estar verificado en Resend
const FROM_NAME  = "IRONQx · Formulario";
const ASSIGNMENT_API_URL = "https://app.ironqx.fit/api/intake-assignment";

// ─── CORS ────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "X-IronQx-Worker-Version": "20261111-premium",
};

// ─── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST")   return new Response("Method not allowed", { status: 405 });

    try {
      const data = await request.json();
      const { campos = {}, radios = {}, checks = {}, alimentos = {}, escalas = {}, horarios = {}, contacto = {}, metadata = {} } = data;
      const assignmentId = validAssignmentId(data.assignmentId);
      // El paciente es la segunda via: si el id de asignacion no llego o no es
      // valido, el endpoint de la app resuelve la asignacion abierta por
      // paciente. Antes, sin id, el envio se iba solo por correo y la
      // asignacion se quedaba "Pendiente" aunque el paciente lo completara.
      const patientId = validPatientId(data.patientId);
      limpiarPayload({ campos, checks, alimentos, horarios });

      // ── Anti-spam: honeypot + time-trap. Si se dispara, fingimos éxito
      //    y descartamos en silencio (el bot no reintenta).
      const fillMs = Number(metadata.fillMs);
      const tooFast = Number.isFinite(fillMs) && fillMs < 4000; // <4s = bot
      if (data.hp || data.website || campos["_gotcha"] || tooFast) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      // Una asignacion vinculada se guarda primero en la app. El correo queda
      // como copia de respaldo y no condiciona la recepcion del intake.
      //
      // El decir y el hacer no coincidian: si la app fallaba, esto abortaba el
      // envio entero y el correo tampoco salia. Un hipo de app.ironqx.fit le
      // costaba al paciente el formulario completo y un "Error al enviar" que
      // solo podia resolver reintentando. Ahora se reintenta una vez y, si
      // sigue cayendo, el intake se va por correo igual: se falla solo cuando
      // no llega por ninguna via.
      let assignmentSaved = false;
      if (assignmentId || patientId) {
        const responseData = { ...data };
        delete responseData.assignmentId;
        delete responseData.patientId;
        delete responseData.hp;
        const guardarAsignacion = () => fetch(ASSIGNMENT_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "submit",
            assignmentId,
            patientId,
            response: responseData,
          }),
        }).catch(() => null);

        let assignmentRes = await guardarAsignacion();
        if (!assignmentRes || !assignmentRes.ok) {
          await new Promise(resolve => setTimeout(resolve, 700));
          assignmentRes = await guardarAsignacion();
        }
        if (assignmentRes && assignmentRes.ok) {
          const assignmentResult = await assignmentRes.json().catch(() => ({}));
          if (assignmentResult.duplicate) {
            return new Response(JSON.stringify({ success: true, duplicate: true }), {
              headers: { "Content-Type": "application/json", ...CORS },
            });
          }
          assignmentSaved = true;
        } else {
          const detalle = assignmentRes ? await assignmentRes.text().catch(() => "") : "sin respuesta";
          console.error("Assignment save error:", assignmentRes ? assignmentRes.status : "network", detalle);
        }
      }

      // Fallback robusto: usa contacto (extracción directa) o busca en campos normalizados
      const nombre        = contacto.nombre   || campos["Nombre completo"]       || campos["Nombre"]      || "Paciente";
      const emailPaciente = contacto.email    || campos["Correo electrónico"]    || campos["Correo"]      || "";
      const telefono      = contacto.telefono || campos["Teléfono"]              || campos["Telefono"]    || "";
      const fecha         = metadata.fecha || new Date().toLocaleDateString("es-EC");

      // Validación de email server-side: si es inválido NO rompemos el envío,
      // solo omitimos el correo de confirmación al paciente (no perdemos el lead).
      const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPaciente);

      const datos = { nombre, emailPaciente, telefono, fecha, campos, radios, checks, alimentos, escalas, horarios };
      const emailHtml = buildEmail(datos);
      const ficha = fichaTexto(datos);
      const objetivoTxt = prettyVal("objetivo", radios.objetivo || "");
      const conf = { nombre, ...datosConfirmacion({ radios, horarios, fecha }) };

      // Email 1 · Aviso interno al coach con la ficha completa
      const emailCoach = {
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to:   [TO_EMAIL],
        reply_to: emailValido ? emailPaciente : undefined,
        subject: oneLine(`Nueva ficha · ${nombre}${objetivoTxt ? " · " + objetivoTxt : ""} · ${fecha}`),
        html: emailHtml,
        text: ficha,
        attachments: [{
          filename: `ficha-${slugNombre(nombre)}-${new Date().toISOString().slice(0, 10)}.json`,
          content: base64Utf8(JSON.stringify({ version: 1, fecha, contacto: { nombre, email: emailPaciente, telefono }, campos, radios, checks, alimentos, escalas, horarios, ficha_texto: ficha }, null, 2)),
        }],
      };

      // Email 2 · Confirmación al paciente (branded, sin datos clínicos internos)
      const lote = [emailCoach];
      if (emailValido) {
        lote.push({
          from: `IRONQx · Coaching <${FROM_EMAIL}>`,
          to:   [emailPaciente],
          reply_to: TO_EMAIL,
          subject: oneLine(`${primerNombre(nombre) ? primerNombre(nombre) + ", recibimos" : "Recibimos"} tu ficha · IRONQx`),
          html: buildConfirmEmail(conf),
          text: confirmText(conf),
        });
      }

      // Envío en lote (1 sola llamada) vía Resend
      let resendRes;
      try {
        resendRes = await fetch("https://api.resend.com/emails/batch", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(lote),
        });
      } catch (emailError) {
        console.error("Resend network error:", emailError);
        if (assignmentSaved) {
          return new Response(JSON.stringify({ success: true, emailSent: false }), {
            headers: { "Content-Type": "application/json", ...CORS },
          });
        }
        throw emailError;
      }

      if (!resendRes.ok) {
        const err = await resendRes.text();
        // Log completo en Cloudflare (wrangler tail / dashboard), respuesta genérica al cliente.
        console.error("Resend error:", resendRes.status, err);
        if (assignmentSaved) {
          return new Response(JSON.stringify({ success: true, emailSent: false, emailStatus: resendRes.status }), {
            headers: { "Content-Type": "application/json", ...CORS },
          });
        }
        // El codigo de Resend viaja en la respuesta: sin el, un fallo de correo
        // solo se puede diagnosticar abriendo los logs del panel, y desde fuera
        // todo se ve igual (500 generico). El texto para el paciente no cambia.
        const fallo = new Error("RESEND_FAIL");
        fallo.stage = "email";
        fallo.status = resendRes.status;
        throw fallo;
      }

      return new Response(JSON.stringify({ success: true, emailSent: true, assignmentSaved }), {
        headers: { "Content-Type": "application/json", ...CORS },
      });

    } catch (err) {
      console.error("Worker error:", err && err.stack ? err.stack : err);
      return new Response(JSON.stringify({
        success: false,
        error: "No se pudo enviar el formulario. Intenta de nuevo en unos minutos.",
        stage: err && err.stage ? err.stage : undefined,
        status: err && err.status ? err.status : undefined,
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
  },
};

function validPatientId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

function validAssignmentId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : "";
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEGURIDAD / NORMALIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/** Escapa HTML para impedir inyección en el correo. Aplicar a TODO dato del usuario. */
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Colapsa saltos de línea para cabeceras (asunto). */
function oneLine(v) {
  return String(v).replace(/[\r\n]+/g, " ").trim();
}

// Diccionarios value→label para mostrar texto legible en lugar de slugs/factores.
const VAL_MAP = {
  // Vida diaria sin entrenamiento (NEAT). El gasto del entreno se suma
  // aparte con días × duración, no va dentro de este factor.
  actividad: {
    "1.25": "Escritorio · menos de 5.000 pasos",
    "1.35": "Poco activo · 5.000 a 7.500 pasos",
    "1.45": "Activo · 7.500 a 10.000 pasos",
    "1.6":  "Trabajo físico · más de 10.000 pasos",
    // Valores del modelo anterior (fichas enviadas antes del cambio)
    "1.2":   "Sedentario (escala antigua)",
    "1.375": "Ligero 1-3 días (escala antigua)",
    "1.55":  "Moderado 3-5 días (escala antigua)",
    "1.725": "Intenso 6-7 días (escala antigua)",
    "1.9":   "Muy intenso (escala antigua)",
  },
  "duracion-sesion": {
    "35":  "Menos de 45 min",
    "55":  "45 a 60 min",
    "75":  "60 a 90 min",
    "100": "Más de 90 min",
  },
  objetivo: {
    perdida_grasa:     "Pérdida de grasa corporal",
    ganancia_muscular: "Ganancia de masa muscular",
    recomposicion:     "Recomposición corporal",
    mantenimiento:     "Mantenimiento / Performance",
    salud:             "Mejora de salud general",
  },
  somatotipo: { ectomorfo: "Ectomorfo", mesomorfo: "Mesomorfo", endomorfo: "Endomorfo" },
  dieta: { omnivoro: "Omnívoro", flexitariano: "Flexitariano", vegetariano: "Vegetariano", vegano: "Vegano", pescetariano: "Pescetariano", cetogenica: "Cetogénica", paleo: "Paleo", otra: "Otra específica" },
  preparacion: { simple: "Simple (recetas rápidas)", mealprep: "Meal prep (cocina por tandas)", gourmet: "Gourmet", premade: "Preparado / compra lista" },
  "nivel-experiencia": { principiante: "Principiante", intermedio: "Intermedio", avanzado: "Avanzado" },
  ciclo: { regular: "Regular (28-30 días)", irregular: "Irregular", anticonceptivo: "Anticonceptivo hormonal", menopausia: "Menopausia", noaplica: "No aplica" },
  // (DUR_PED y MON_PED se usan aparte porque son campos select, no radios)
  // Los valores que envía el formulario (casa_mancuernas, peso_corporal);
  // casa/minimo quedan por fichas antiguas.
  equipamiento: {
    gym_completo:    "Gym completo",
    gym_basico:      "Gym básico",
    casa_mancuernas: "Casa con mancuernas",
    peso_corporal:   "Solo peso corporal",
    casa:            "Casa",
    minimo:          "Equipamiento mínimo",
  },
  comidas: {
    "3": "3 comidas",
    "4": "4 comidas",
    "5": "5 comidas",
    "6": "6 comidas",
    ayuno: "Ayuno intermitente",
  },
  timing: {
    manana: "Mañana (5-9 AM)",
    mediodia: "Mediodía (12-2 PM)",
    tarde: "Tarde (4-7 PM)",
    noche: "Noche (7-10 PM)",
    mixto: "Mixto (2 sesiones)",
  },
};

// Mapas para selects de PEDs (value → texto legible)
const DUR_PED = {
  "<6m": "Menos de 6 meses", "6m-1a": "6 meses - 1 año",
  "1-3a": "1-3 años", "3-5a": "3-5 años", ">5a": "Más de 5 años",
};
const MON_PED = { si: "Sí, regular", ocasional: "Ocasional", no: "No" };

/** Devuelve label legible: diccionario explícito, o prettify genérico de slugs. */
function prettyVal(key, val) {
  if (!val) return "";
  if (VAL_MAP[key] && VAL_MAP[key][val]) return VAL_MAP[key][val];
  return String(val).replace(/[_-]+/g, " ").replace(/^\w/u, m => m.toUpperCase());
}


// ═══════════════════════════════════════════════════════════════════════════
//  DATOS LIMPIOS (también para quien tenga en caché el formulario anterior)
//  · sin emojis en etiquetas ni valores (la ficha la lee la skill tal cual)
//  · sin el «on» que dejaban las casillas dentro de un campo
//  · listas desplegables con su texto, no con el código
// ═══════════════════════════════════════════════════════════════════════════
const RE_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;
function sinEmoji(v) { return String(v == null ? "" : v).replace(RE_EMOJI, "").replace(/[ \t]+/g, " ").trim(); }
const SELECT_MAP = {
  "Horas de sueño promedio": { "4": "Menos de 5 horas", "5": "5-6 horas", "6": "6-7 horas", "7": "7-8 horas", "8": "8-9 horas", "9": "Más de 9 horas" },
  "Frecuencia deseada": { ninguna: "Ninguna (estricto)", semanal: "1 vez por semana", quincenal: "1 vez cada 2 semanas", mensual: "1 vez al mes", libre: "Intuitivo / libre" },
  "Presupuesto semanal alimentario (USD)": { bajo: "Económico ($30-50)", medio: "Moderado ($50-100)", alto: "Flexible ($100-150)", premium: "Premium ($150+)" },
  "Tiempo disponible para cocinar (min/día)": { "15": "15 minutos", "30": "30 minutos", "45": "45 minutos", "60": "1 hora", "90": "Más de 1 hora" },
};
function limpiarPayload({ campos, checks, alimentos, horarios }) {
  for (const k of Object.keys(campos)) {
    const v = campos[k];
    if (v === "on" || v === "off") { delete campos[k]; continue; }
    if (SELECT_MAP[k] && SELECT_MAP[k][v]) campos[k] = SELECT_MAP[k][v];
    else if (typeof v === "string") campos[k] = v.replace(RE_EMOJI, "").trim();
  }
  for (const obj of [checks, alimentos]) {
    for (const k of Object.keys(obj)) {
      const lista = listaSegura(obj[k]).map(sinEmoji).filter(Boolean);
      const limpio = sinEmoji(k);
      delete obj[k];
      if (lista.length) obj[limpio] = lista;
    }
  }
  for (const k of Object.keys(horarios)) if (typeof horarios[k] === "string") horarios[k] = sinEmoji(horarios[k]);
}

// ═══════════════════════════════════════════════════════════════════════════
//  TEMA DE CORREO (el mismo de la app: negro profundo, oro, logo en PNG)
//  Tablas y estilos en línea; imágenes PNG por URL; fondos «blindados»
//  contra el modo oscuro de Gmail (degradado de un tono + bgcolor).
// ═══════════════════════════════════════════════════════════════════════════
const APP_URL = "https://app.ironqx.fit";
const T = { PAGE: "#050506", CARD: "#0d0e12", INNER: "#0b0c10", GOLD: "#C9A84C", GOLD_LT: "#F2CB68", INK: "#ECEEF4", SOFT: "#c3c8d4", MUTED: "#8b90a0", LINE: "rgba(255,255,255,.07)" };
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const BRAND = "Michroma,'Helvetica Neue',Helvetica,Arial,sans-serif";
const bgc = c => `background-color:${c};background-image:linear-gradient(${c},${c});`;

function docShell({ title, preheader, kicker, name, heading, sub, body, footer, width = 600 }) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<style>@font-face{font-family:'Michroma';font-style:normal;font-weight:400;src:url('${APP_URL}/fonts/michroma-400-latin.woff2') format('woff2');}</style>
<title>${esc(title)}</title></head>
<body bgcolor="${T.PAGE}" style="margin:0;padding:0;${bgc(T.PAGE)}-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.PAGE}" style="${bgc(T.PAGE)}">
 <tr><td align="center" bgcolor="${T.PAGE}" style="padding:26px 10px 40px;${bgc(T.PAGE)}">
  <table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.CARD}" style="width:100%;max-width:${width}px;${bgc(T.CARD)}border:1px solid rgba(201,168,76,.22);border-radius:22px;overflow:hidden;">
   <tr><td style="height:3px;line-height:3px;font-size:0;background:${T.GOLD};background-image:linear-gradient(90deg,#7A6018,${T.GOLD},${T.GOLD_LT},${T.GOLD},#7A6018);">&nbsp;</td></tr>
   <tr><td align="center" bgcolor="${T.CARD}" style="padding:30px 28px 0;background-color:${T.CARD};background-image:radial-gradient(80% 120% at 50% 0%,rgba(201,168,76,.16),rgba(13,14,18,0) 70%);">
     <img src="${APP_URL}/icons/email-logo.png" width="110" height="70" alt="IRONQx" style="display:block;width:110px;height:70px;border:0;outline:none;">
     <img src="${APP_URL}/icons/email/marca.png" width="170" height="22" alt="IRONQX" style="display:block;margin:10px auto 0;width:170px;height:22px;border:0;outline:none;">
     <div style="margin-top:7px;font-family:${SANS};font-size:9px;letter-spacing:3.2px;color:${T.MUTED};">CLINICAL &amp; PERFORMANCE</div>
   </td></tr>
   <tr><td align="center" bgcolor="${T.CARD}" style="padding:26px 28px 6px;${bgc(T.CARD)}">
     ${kicker ? `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:${T.GOLD};">${kicker}</div>` : ""}
     ${name ? `<div style="margin-top:12px;font-family:${SERIF};font-size:24px;font-style:italic;line-height:1.3;color:${T.GOLD_LT};">${name}</div>` : ""}
     ${heading ? `<h1 style="margin:8px 0 0;font-family:${BRAND};font-size:22px;font-weight:normal;letter-spacing:.5px;line-height:1.4;color:${T.INK};">${heading}</h1>` : ""}
     ${sub ? `<div style="margin-top:10px;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.MUTED};">${sub}</div>` : ""}
   </td></tr>
   ${body}
   <tr><td bgcolor="${T.CARD}" style="padding:26px 28px 28px;${bgc(T.CARD)}">
     <div style="border-top:1px solid ${T.LINE};padding-top:16px;text-align:center;font-family:${SANS};font-size:11px;line-height:1.7;color:#6b7080;">
       ${footer || ""}
       <div style="margin-top:6px;"><a href="https://ironqx.fit" style="color:${T.GOLD};text-decoration:none;letter-spacing:1px;">ironqx.fit</a></div>
     </div>
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}
const rowT = (inner, pad = "0 24px 18px") => `<tr><td bgcolor="${T.CARD}" style="padding:${pad};${bgc(T.CARD)}">${inner}</td></tr>`;
function cardT(inner, { gold = false, pad = "16px 18px", tone } = {}) {
  const c = tone || (gold ? "#14110a" : T.INNER);
  const brd = gold ? "rgba(201,168,76,.38)" : T.LINE;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c}" style="${bgc(c)}border:1px solid ${brd};border-radius:14px;">
    <tr><td bgcolor="${c}" style="padding:${pad};${bgc(c)}border-radius:14px;">${inner}</td></tr></table>`;
}
const kickerT = (t, color = T.GOLD) => `<div style="font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:2.6px;text-transform:uppercase;color:${color};">${t}</div>`;
function buttonT(text, href, { ghost = false } = {}) {
  return ghost
    ? `<td align="center" style="border-radius:999px;border:1px solid rgba(201,168,76,.45);"><a href="${href}" target="_blank" style="display:inline-block;padding:12px 20px;font-family:${SANS};font-size:13px;font-weight:bold;color:${T.GOLD_LT};text-decoration:none;border-radius:999px;">${text}</a></td>`
    : `<td align="center" bgcolor="${T.GOLD}" style="border-radius:999px;background:${T.GOLD};background-image:linear-gradient(135deg,#A88A32 0%,${T.GOLD} 40%,${T.GOLD_LT} 70%,${T.GOLD} 100%);"><a href="${href}" target="_blank" style="display:inline-block;padding:12px 20px;font-family:${SANS};font-size:13px;font-weight:bold;color:#0b0b0d;text-decoration:none;border-radius:999px;">${text}</a></td>`;
}
function stepsT(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items.map((t, i) => `
    <tr><td width="34" valign="top" style="padding:0 0 ${i === items.length - 1 ? 0 : 14}px;">
      <div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:rgba(201,168,76,.14);border:1px solid rgba(201,168,76,.4);text-align:center;font-family:${SANS};font-size:12px;font-weight:bold;color:${T.GOLD_LT};">${i + 1}</div></td>
    <td valign="top" style="padding:2px 0 ${i === items.length - 1 ? 0 : 14}px;font-family:${SANS};font-size:14px;line-height:1.6;color:${T.SOFT};">${t}</td></tr>`).join("")}</table>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PLANTILLA DE EMAIL
// ═══════════════════════════════════════════════════════════════════════════

function buildEmail({ nombre, emailPaciente, telefono, fecha, campos, radios, checks, alimentos, escalas, horarios = {} }) {
  // Todos los accesores ESCAPAN por defecto:
  const c  = k => esc(campos[k] || "");                       // texto/número
  const r  = k => esc(radios[k] || "");                       // radio crudo (para comparaciones M/F, si/no)
  const rp = k => esc(prettyVal(k, radios[k] || ""));         // radio con label legible
  const ch = k => checks[k] || [];                            // arrays: se escapan dentro de tagRow

  // Versiones escapadas de los datos de contacto para uso inline en el HTML
  const nombreH = esc(nombre), emailH = esc(emailPaciente), telH = esc(telefono);
  const schedule = buildScheduleSummary(horarios);

  // IMC automático si hay datos (solo números → seguro)
  const imc = (() => {
    const h = parseFloat(campos["Estatura (cm)"]), w = parseFloat(campos["Peso actual (kg)"]);
    if (!h || !w) return "";
    const v = w / Math.pow(h / 100, 2);
    const cat = v < 18.5 ? "Bajo peso" : v < 25 ? "Normal" : v < 30 ? "Sobrepeso" : "Obesidad";
    const col = v < 18.5 ? "#4490ee" : v < 25 ? "#35b06a" : v < 30 ? "#d4a843" : "#d94f4f";
    return `<span style="font-weight:800;color:${col}">${v.toFixed(1)}</span> <span style="color:#8b90a0;font-size:11px">(${cat})</span>`;
  })();

  const alertas = alertasClinicas({ campos, radios, checks, escalas });
  const telDig = String(telefono || "").replace(/\D/g, "").replace(/^0/, "593");
  const acciones = rowT(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
      ${telDig ? buttonT("WhatsApp", "https://wa.me/" + telDig) : ""}${telDig && emailH ? '<td width="8"></td>' : ""}${emailH ? buttonT("Responder", "mailto:" + emailH, { ghost: true }) : ""}
    </tr></table>`, "6px 24px 18px");
  const fichaTxt = fichaTexto({ nombre, emailPaciente, telefono, fecha, campos, radios, checks, alimentos, escalas, horarios });
  return docShell({
    title: "Nueva ficha · " + nombre,
    preheader: [prettyVal("objetivo", radios.objetivo || ""), alertas.length ? alertas.length + " alertas para revisar" : "sin alertas"].filter(Boolean).join(" · "),
    kicker: "Nueva ficha de ingreso",
    name: nombreH,
    sub: [esc(fecha), emailH, telH].filter(Boolean).join(" &nbsp;·&nbsp; "),
    width: 640,
    footer: "Información clínica confidencial · generado al enviar el formulario.<br>Adjunto: la ficha en .json para la skill ironqx-builder-plan.",
    body: `
      ${acciones}
      ${resumenEjecutivo({ nombreH, imc, r, rp, c, escalas })}
      ${bloqueAlertas(alertas)}
      <!-- 01 · CONTACTO -->
      ${bloque("01", "Datos de Contacto", "", [
        fila("Nombre",       nombreH),
        fila("Teléfono",     telH || c("Teléfono")),
        fila("Correo",       emailH || c("Correo electrónico")),
        fila("Ciudad",       c("Ciudad")),
        fila("Nacimiento",   c("Fecha de nacimiento")),
        fila("Edad",         c("Edad calculada") ? c("Edad calculada") + " años" : ""),
        fila("Ocupación",    c("Ocupación / Profesión")),
      ])}

      <!-- 02 · FÍSICO -->
      ${bloque("02", "Datos Físicos", "", [
        fila("Estatura",     c("Estatura (cm)") ? c("Estatura (cm)") + " cm" : ""),
        fila("Peso actual",  c("Peso actual (kg)") ? c("Peso actual (kg)") + " kg" : ""),
        fila("Sexo",         r("sexo") === "M" ? "Masculino" : r("sexo") === "F" ? "Femenino" : c("Sexo") === "M" ? "Masculino" : c("Sexo") === "F" ? "Femenino" : ""),
        fila("IMC", imc),
        fila("Somatotipo",   rp("somatotipo")),
        fila("% Grasa",      c("% Grasa corporal") ? c("% Grasa corporal") + "%" : ""),
        fila("Cintura",      c("Cintura (cm)") ? c("Cintura (cm)") + " cm" : ""),
        fila("Cadera",       c("Cadera (cm)") ? c("Cadera (cm)") + " cm" : ""),
        fila("C/C",          c("Relación Cintura/Cadera")),
      ])}

      <!-- 03 · ENTRENAMIENTO -->
      ${bloque("03", "Entrenamiento", "", [
        fila("Nivel",        rp("nivel-experiencia")),
        fila("Días/semana",  c("Días/semana") || (r("dias-entreno") === "0" ? "Aún no entrena" : r("dias-entreno"))),
        fila("Duración sesión", rp("duracion-sesion")),
        fila("Horario",      esc(horarios["Horario de entrenamiento"] || "")),
        fila("Equipamiento", rp("equipamiento")),
        fila("Gimnasio",     c("Nombre del gimnasio (si aplica)")),
        ch("Lesiones activas").length ? tagRow("Lesiones activas", ch("Lesiones activas"), "#d94f4f") : "",
        c("Especifique la lesión activa") ? fila("Detalle lesión", c("Especifique la lesión activa")) : "",
        c("Lesiones pasadas relevantes (cirugías, fracturas, rehabilitaciones)") ?
          fila("Historial", c("Lesiones pasadas relevantes (cirugías, fracturas, rehabilitaciones)")) : "",
        cleanScheduleFallback(campos["Cualquier detalle extra que deba conocer sobre tu entrenamiento"]) ?
          fila("Observaciones", esc(cleanScheduleFallback(campos["Cualquier detalle extra que deba conocer sobre tu entrenamiento"]))) : "",
      ])}

      <!-- 04 · SALUD -->
      ${bloque("04", "Salud", "", [
        tagRow("Condiciones médicas", ch("Condiciones médicas diagnosticadas"), "#d94f4f"),
        c("Lista de medicamentos / suplementos y dosis") ? fila("Medicamentos", c("Lista de medicamentos / suplementos y dosis")) : "",
        tagRow("Alergias alimentarias", ch("Alergias alimentarias conocidas"), "#d4a843"),
        tagRow("Síntomas gastrointestinales", ch("Síntomas gastrointestinales frecuentes"), "#d4a843"),
      ])}

      <!-- 05 · ALIMENTACIÓN -->
      ${bloque("05", "Patrón Alimentario", "", [
        fila("Patrón principal", rp("dieta")),
        tagRow("Exclusiones voluntarias", ch("Exclusiones alimentarias voluntarias"), "#888"),
      ])}

      <!-- 06–09 · ALIMENTOS SELECCIONADOS -->
      ${Object.values(alimentos).some(v => listaSegura(v).length > 0) ? bloqueAlimentos(alimentos) : ""}

      <!-- 10 · METABOLISMO -->
      ${bloque("10", "Metabolismo", "", [
        fila("Vida diaria (NEAT)",  rp("actividad")),
        fila("FC reposo",           c("FC en reposo (lpm)") ? c("FC en reposo (lpm)") + " lpm" : ""),
        fila("FC máxima",           c("FC máxima estimada") ? c("FC máxima estimada") + " lpm" : ""),
        // Las fichas antiguas llegan con los nombres de antes.
        fila("Zona 2 · base aeróbica", c("Zona 2 · base aeróbica (60-70%)") || c("Zona aeróbica (60-70%)")),
        fila("Zona 3 · tempo",      c("Zona 3 · tempo (70-80%)") || c("Zona quema grasa (70-80%)")),
        fila("TMB estimada",        c("Tasa Metabólica Basal") ? c("Tasa Metabólica Basal") + " kcal/día" : ""),
        fila("GET estimado",        c("Gasto Energético Total") ? c("Gasto Energético Total") + " kcal/día" : ""),
        fila("Proteína rec.",       c("Proteína Recomendada") ? c("Proteína Recomendada") + " g/día" : ""),
        fila("Agua rec.",           c("Agua Recomendada") ? c("Agua Recomendada") + " ml/día" : ""),
        fila("Glucosa ayunas",      c("Glucosa en ayunas (mg/dL)") ? c("Glucosa en ayunas (mg/dL)") + " mg/dL" : ""),
        fila("HbA1c",              c("HbA1c (%)") ? c("HbA1c (%)") + "%" : ""),
        fila("Colesterol total",    c("Colesterol total (mg/dL)") ? c("Colesterol total (mg/dL)") + " mg/dL" : ""),
        fila("HDL",                 c("HDL (mg/dL)") ? c("HDL (mg/dL)") + " mg/dL" : ""),
        fila("LDL",                 c("LDL (mg/dL)") ? c("LDL (mg/dL)") + " mg/dL" : ""),
        fila("Triglicéridos",       c("Triglicéridos (mg/dL)") ? c("Triglicéridos (mg/dL)") + " mg/dL" : ""),
        fila("TSH",                 c("TSH (mIU/L)") ? c("TSH (mIU/L)") + " mIU/L" : ""),
        fila("Vitamina D",          c("Vitamina D (ng/mL)") ? c("Vitamina D (ng/mL)") + " ng/mL" : ""),
        fila("Testosterona total",  c("Testosterona total (ng/dL)") ? c("Testosterona total (ng/dL)") + " ng/dL" : ""),
        fila("Estradiol",           c("Estradiol (pg/mL)") ? c("Estradiol (pg/mL)") + " pg/mL" : ""),
      ])}

      <!-- 11 · BIENESTAR -->
      ${bloque("11", "Bienestar y Recuperación", "", [
        escalaRow("Energía diaria",    escalas.energia),
        escalaRow("Calidad del sueño", escalas.sueno),
        escalaRow("Nivel de estrés",   escalas.estres),
        fila("Horas de sueño",         c("Horas de sueño promedio")),
        tagRow("Problemas de sueño",   ch("Problemas específicos de sueño"), "#888"),
      ])}

      <!-- 12 · OBJETIVOS -->
      ${bloque("12", "Objetivos", "", [
        fila("Objetivo principal",  rp("objetivo")),
        fila("Peso objetivo",       c("Peso objetivo (kg)") ? c("Peso objetivo (kg)") + " kg" : ""),
        fila("Plazo",               c("Plazo deseado (semanas)") ? c("Plazo deseado (semanas)") + " semanas" : ""),
        fila("Motivación",          c("Motivación principal")),
        escalaRow("Compromiso",     escalas.compromiso),
        tagRow("Historial de dietas", ch("Historial de dietas previas (¿qué has intentado?)"), "#4490ee"),
        c("¿Qué funcionó mejor en el pasado? ¿Qué fue lo peor?") ?
          fila("Experiencias previas", c("¿Qué funcionó mejor en el pasado? ¿Qué fue lo peor?")) : "",
      ])}

      <!-- 13 · LOGÍSTICA -->
      ${bloque("13", "Logística del Plan", "", [
        fila("Frecuencia de comidas",  rp("comidas")),
        fila("Horarios de comida",     schedule.mealsText),
        fila("Hora de entrenamiento",  schedule.trainingTime),
        fila(horarios["Segunda sesión"] ? "Segunda sesión" : "Otra hora de entreno",
          esc(horarios["Segunda sesión"] || horarios["Otra hora de entrenamiento"] || "")),
        fila("Franja de entrenamiento", rp("timing")),
        tagRow("Antes de entrenar prefiere",   ch("Antes de entrenar prefiere"), "#d4a843"),
        tagRow("Después de entrenar prefiere", ch("Después de entrenar prefiere"), "#d4a843"),
        fila("Pre-entreno probable",   schedule.pre),
        fila("Post-entreno probable",  schedule.post),
        fila("Estilo preparación",     rp("preparacion")),
        fila("Cheat meals",            c("Frecuencia deseada")),
        fila("Presupuesto semanal",    c("Presupuesto semanal alimentario (USD)")),
        fila("Tiempo para cocinar",    c("Tiempo disponible para cocinar (min/día)")),
        fila("Alimentos trigger",      c("Alimentos \"trigger\" (que desencadenan atracones)")),
      ])}

      <!-- 14 · SUPLEMENTOS -->
      ${bloque("14", "Suplementación y PEDs", "", [
        tagRow("Suplementos básicos",     ch("Suplementos básicos (seleccione los que toma actualmente)"), "#35b06a"),
        tagRow("Ergogénicos",             ch("Suplementos ergogénicos / Performance"), "#35b06a"),
        fila("Uso de PEDs",               r("peds") === "si" ? "Sí, actualmente"
                                        : r("peds") === "anterior" ? "Usó anteriormente" : r("peds") === "no" ? "No usa"
                                        : r("peds") || "No indicado"),
        tagRow("Sustancias utilizadas",   ch("Sustancias utilizadas (seleccione todas)"), "#d94f4f"),
        fila("Duración del uso",          esc(DUR_PED[campos["Duración del uso"]] || campos["Duración del uso"] || "")),
        fila("Monitoreo médico",          esc(MON_PED[campos["¿Monitoreo médico actual?"]] || campos["¿Monitoreo médico actual?"] || "")),
        fila("Esquema PEDs",              c("Detalles adicionales / Esquema aproximado")),
        fila("Ciclo menstrual",           esc(prettyVal("ciclo", radios.ciclo || radios["ciclo-menstrual"] || ""))),
      ])}

      <!-- 15 · INFO ADICIONAL -->
      ${c("¿Hay algo más que debamos saber?") ? bloque("15", "Información Adicional", "💬", [
        `<tr><td colspan="2" style="padding:10px 0;font-family:${SANS};font-size:14px;color:${T.INK};line-height:1.7">${c("¿Hay algo más que debamos saber?")}</td></tr>`,
      ]) : ""}

      ${c("Firma digital (escriba su nombre completo)") ? rowT(`<div style="font-family:${SANS};font-size:12px;color:${T.MUTED};text-align:center;">Firmado por <b style="color:${T.INK};">${c("Firma digital (escriba su nombre completo)")}</b> · ${c("Fecha") || esc(fecha)}</div>`, "4px 24px 18px") : ""}
      ${rowT(cardT(`${kickerT("Ficha para la skill · copia y pega")}<div style="margin-top:4px;font-family:${SANS};font-size:11px;color:${T.MUTED};">Mismo orden que la ficha de verificación de ironqx-builder-plan. También va adjunta en .json.</div>
        <pre style="margin:12px 0 0;white-space:pre-wrap;word-break:break-word;font-family:Menlo,Consolas,'Courier New',monospace;font-size:11.5px;line-height:1.6;color:${T.SOFT};">${esc(fichaTxt)}</pre>`, { pad: "16px 18px" }))}
    `,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  EMAIL DE CONFIRMACIÓN AL PACIENTE (branded, sin datos clínicos internos)
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS DE PLANTILLA
// ═══════════════════════════════════════════════════════════════════════════




/* El formulario manda listas. Si un dato llega con otra forma —texto suelto,
   un numero, null— el .map reventaba y con el la peticion entera: el envio se
   perdia y el paciente veia "Error al enviar" sin saber por que. Un dato con
   forma rara puede costar su fila del correo; no el correo. */
function listaSegura(value) {
  if (Array.isArray(value))
    return value.filter(v => v !== null && v !== undefined && String(v).trim() !== "");
  if (value === null || value === undefined) return [];
  const texto = String(value).trim();
  return texto ? [texto] : [];
}

function buildScheduleSummary(horarios) {
  const source = horarios && typeof horarios === "object" ? horarios : {};
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  const meals = Object.entries(source)
    .filter(([label, value]) => /^(Comida \d+|Primera ingesta|Última ingesta)$/i.test(label) && timePattern.test(String(value || "")))
    .map(([label, value]) => ({ label, time: String(value), minutes: timeToMinutes(value) }))
    .sort((a, b) => a.minutes - b.minutes);
  const training = timePattern.test(String(source.Entrenamiento || ""))
    ? { time: String(source.Entrenamiento), minutes: timeToMinutes(source.Entrenamiento) }
    : null;

  let pre = "";
  let post = "";
  if (training && meals.length) {
    const before = meals.filter(meal => meal.minutes <= training.minutes).at(-1);
    const after = meals.find(meal => meal.minutes >= training.minutes);
    if (before) pre = `${esc(before.label)} · ${esc(before.time)} (${formatTimeDistance(training.minutes - before.minutes)} antes)`;
    if (after) post = `${esc(after.label)} · ${esc(after.time)} (${formatTimeDistance(after.minutes - training.minutes)} después)`;
  }

  return {
    mealsText: meals.map(meal => `${esc(meal.label)} · ${esc(meal.time)}`).join(" &nbsp;·&nbsp; "),
    trainingTime: training ? esc(training.time) : "",
    pre,
    post,
  };
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return (hours * 60) + minutes;
}

function formatTimeDistance(minutes) {
  if (minutes === 0) return "misma hora";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  if (!rest) return `${hours} h`;
  return `${hours} h ${rest} min`;
}

function cleanScheduleFallback(value) {
  const text = String(value || "");
  const markerIndex = text.indexOf("[HORARIOS PARA PLANIFICACIÓN]");
  return (markerIndex >= 0 ? text.slice(0, markerIndex) : text).trim();
}

/** Resumen de un vistazo: tarjetas con lo que más pesa para planificar. */
function resumenEjecutivo({ nombreH, imc, r, rp, c, escalas }) {
  const objetivo = rp("objetivo");
  const get = c("Gasto Energético Total"), prote = c("Proteína Recomendada"), dias = r("dias-entreno");
  const sexo = r("sexo") === "M" ? "Hombre" : r("sexo") === "F" ? "Mujer" : "";
  const edad = c("Edad calculada");
  const peso = c("Peso actual (kg)"), meta = c("Peso objetivo (kg)");
  const kpi = (label, valor, sub) => valor ? `<td width="33%" valign="top" style="padding:5px;">
      ${cardT(`<div style="font-family:${SANS};font-size:9px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:${T.MUTED};">${label}</div>
        <div style="margin-top:6px;font-family:${SANS};font-size:17px;font-weight:bold;line-height:1.2;color:${T.INK};">${valor}</div>
        ${sub ? `<div style="margin-top:3px;font-family:${SANS};font-size:11px;color:${T.MUTED};">${sub}</div>` : ""}`, { pad: "12px 12px" })}</td>` : "";
  const celdas = [
    kpi("Objetivo", objetivo, c("Plazo deseado (semanas)") ? c("Plazo deseado (semanas)") + " semanas" : ""),
    kpi("Perfil", [sexo, edad ? edad + " años" : ""].filter(Boolean).join(" · "), c("Estatura (cm)") ? c("Estatura (cm)") + " cm" : ""),
    kpi("Peso", peso ? peso + " kg" : "", meta ? "Meta " + meta + " kg" : ""),
    kpi("IMC", imc, c("% Grasa corporal") ? c("% Grasa corporal") + " % grasa" : ""),
    kpi("Gasto estimado", get ? get + " kcal" : "", prote ? "Proteína " + prote + " g" : ""),
    kpi("Entreno", dias === "0" ? "Aún no entrena" : dias ? dias + " días/sem" : "", rp("duracion-sesion")),
  ].filter(Boolean);
  if (!celdas.length) return "";
  let filas = "";
  for (let i = 0; i < celdas.length; i += 3) filas += `<tr>${celdas.slice(i, i + 3).join("")}${"<td></td>".repeat(3 - celdas.slice(i, i + 3).length)}</tr>`;
  return rowT(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${filas}</table>`, "6px 19px 14px");
}

/** Sección con número en insignia y título; filas clave → valor. */
function bloque(num, titulo, _icono, filas) {
  const contenido = filas.filter(Boolean).join("");
  if (!contenido.replace(/<[^>]*>/g, "").trim()) return "";
  return rowT(cardT(`
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="34" valign="middle"><div style="width:26px;height:26px;line-height:26px;border-radius:8px;text-align:center;font-family:${SANS};font-size:11px;font-weight:bold;color:#0b0b0d;background:${T.GOLD};background-image:linear-gradient(135deg,${T.GOLD_LT},${T.GOLD});">${num}</div></td>
      <td valign="middle" style="font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:${T.INK};">${titulo}</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border-top:1px solid ${T.LINE};">${contenido}</table>`, { pad: "16px 18px 10px" }));
}

/** Fila clave → valor. El valor debe venir YA escapado. */
function fila(label, valor) {
  if (!valor || String(valor).trim() === "") return "";
  return `<tr>
    <td valign="top" style="padding:9px 10px 9px 0;width:40%;border-bottom:1px solid ${T.LINE};font-family:${SANS};font-size:12px;color:${T.MUTED};">${label}</td>
    <td valign="top" style="padding:9px 0;border-bottom:1px solid ${T.LINE};font-family:${SANS};font-size:13.5px;line-height:1.5;color:${T.INK};">${valor}</td>
  </tr>`;
}

/** Lista como etiquetas; entre una y otra queda « · » para que al copiar se lea bien. */
function tagRow(label, items, color) {
  const lista = listaSegura(items);
  if (!lista.length) return "";
  const tags = lista.map((i, k) =>
    `<span style="display:inline-block;margin:2px 4px 2px 0;padding:4px 10px;background:${color}1f;border:1px solid ${color}55;border-radius:20px;font-family:${SANS};font-size:12px;color:${T.INK};">${esc(i)}</span>${k < lista.length - 1 ? `<span style="font-size:0;color:transparent;"> · </span>` : ""}`
  ).join("");
  return `<tr>
    <td valign="top" style="padding:9px 10px 9px 0;width:40%;border-bottom:1px solid ${T.LINE};font-family:${SANS};font-size:12px;color:${T.MUTED};">${label}</td>
    <td valign="top" style="padding:7px 0;border-bottom:1px solid ${T.LINE};">${tags}</td>
  </tr>`;
}

/** Escala 1-10 con barra */
function escalaRow(label, valor) {
  if (!valor) return "";
  const n = parseInt(valor) || 0;
  const color = n <= 3 ? "#e06a6a" : n <= 6 ? T.GOLD : "#35b06a";
  const barra = Array.from({ length: 10 }, (_, i) =>
    `<span style="display:inline-block;width:14px;height:7px;border-radius:2px;margin-right:2px;background:${i < n ? color : "rgba(255,255,255,.09)"};"></span>`).join("");
  return `<tr>
    <td valign="middle" style="padding:9px 10px 9px 0;width:40%;border-bottom:1px solid ${T.LINE};font-family:${SANS};font-size:12px;color:${T.MUTED};">${label}</td>
    <td valign="middle" style="padding:9px 0;border-bottom:1px solid ${T.LINE};"><span style="font-family:${SANS};font-weight:bold;font-size:14px;color:${color};margin-right:8px;">${esc(valor)}/10</span>${barra}</td>
  </tr>`;
}

/** Alimentos marcados por grupo */
function bloqueAlimentos(alimentos) {
  const colores = { "Proteínas": "#7f9cf5", "Carbohidratos": "#C9A84C", "Grasas": "#3cc07a", "Vegetales": "#3cc07a", "Frutas": "#e06a6a" };
  const filas = Object.entries(alimentos)
    .map(([cat, items]) => [cat, listaSegura(items)])
    .filter(([, items]) => items.length > 0)
    .map(([cat, items]) => tagRow(`${esc(cat)} <span style="color:#6b7080;">(${items.length})</span>`, items, colores[cat] || "#8b90a0"));
  if (!filas.length) return "";
  return bloque("06", "Alimentos que sí comería", "", filas);
}

/* Alertas para revisar antes de planificar (no son diagnósticos): lo que el
   módulo 08 de la skill pide mirar primero. */
function alertasClinicas({ campos, radios, checks, escalas }) {
  const ninguna = x => /^(ninguna|ninguno|no tengo|nunca)/i.test(String(x).trim());
  const lista = k => listaSegura(checks[k]).filter(x => !ninguna(x));
  const num = k => parseFloat(String(campos[k] || "").replace(",", "."));
  const out = [];
  const cond = lista("Condiciones médicas diagnosticadas"); if (cond.length) out.push(["Condiciones", cond.join(" · ")]);
  if (campos["Lista de medicamentos / suplementos y dosis"]) out.push(["Medicación", campos["Lista de medicamentos / suplementos y dosis"]]);
  const al = lista("Alergias alimentarias conocidas"); if (al.length) out.push(["Alergias", al.join(" · ")]);
  const les = lista("Lesiones activas"); if (les.length || campos["Especifique la lesión activa"]) out.push(["Lesión activa", [les.join(" · "), campos["Especifique la lesión activa"]].filter(Boolean).join(" — ")]);
  const gi = lista("Síntomas gastrointestinales frecuentes"); if (gi.length) out.push(["Digestivo", gi.join(" · ")]);
  if (radios.peds === "si" || radios.peds === "anterior") out.push(["PEDs", (radios.peds === "si" ? "Usa actualmente" : "Usó antes") + (lista("Sustancias utilizadas (seleccione todas)").length ? ": " + lista("Sustancias utilizadas (seleccione todas)").join(" · ") : "")]);
  const lab = [];
  if (num("Glucosa en ayunas (mg/dL)") >= 100) lab.push("glucosa " + campos["Glucosa en ayunas (mg/dL)"] + " mg/dL");
  if (num("HbA1c (%)") >= 5.7) lab.push("HbA1c " + campos["HbA1c (%)"] + " %");
  if (num("LDL (mg/dL)") >= 130) lab.push("LDL " + campos["LDL (mg/dL)"] + " mg/dL");
  if (num("Triglicéridos (mg/dL)") >= 150) lab.push("triglicéridos " + campos["Triglicéridos (mg/dL)"] + " mg/dL");
  const tsh = num("TSH (mIU/L)"); if (tsh && (tsh < 0.4 || tsh > 4.5)) lab.push("TSH " + campos["TSH (mIU/L)"]);
  const vd = num("Vitamina D (ng/mL)"); if (vd && vd < 30) lab.push("vitamina D " + campos["Vitamina D (ng/mL)"] + " ng/mL");
  if (lab.length) out.push(["Laboratorio", lab.join(" · ")]);
  const h = num("Estatura (cm)"), w = num("Peso actual (kg)");
  if (h && w && w / Math.pow(h / 100, 2) >= 30) out.push(["IMC", (w / Math.pow(h / 100, 2)).toFixed(1) + " (obesidad)"]);
  const bien = [];
  if (+escalas.sueno && +escalas.sueno <= 4) bien.push("sueño " + escalas.sueno + "/10");
  if (+escalas.estres >= 8) bien.push("estrés " + escalas.estres + "/10");
  if (+escalas.energia && +escalas.energia <= 3) bien.push("energía " + escalas.energia + "/10");
  if (bien.length) out.push(["Recuperación", bien.join(" · ")]);
  if (radios.ciclo === "irregular") out.push(["Ciclo", "Irregular"]);
  return out;
}
function bloqueAlertas(alertas) {
  if (!alertas.length) return rowT(cardT(`${kickerT("Alertas para revisar", "#3cc07a")}<div style="margin-top:6px;font-family:${SANS};font-size:13px;color:${T.SOFT};">Sin condiciones, lesiones, alergias ni valores fuera de rango.</div>`, { tone: "#0b120e" }));
  return rowT(cardT(`${kickerT("Alertas para revisar · " + alertas.length, "#f3c77a")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${alertas.map(([k, v]) =>
      `<tr><td valign="top" width="30%" style="padding:6px 10px 6px 0;font-family:${SANS};font-size:12px;font-weight:bold;color:#f3c77a;">${esc(k)}</td>
        <td valign="top" style="padding:6px 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.INK};">${esc(v)}</td></tr>`).join("")}</table>`,
    { tone: "#15120a" }).replace("border:1px solid " + T.LINE, "border:1px solid rgba(243,199,122,.35)"));
}

/* Ficha en texto, con las mismas secciones de la «ficha de verificación» de
   la skill ironqx-builder-plan (00_FLUJO_PROTOCOLO). Va al final del correo,
   como versión de texto del mensaje y dentro del .json adjunto. */
function fichaTexto({ nombre, emailPaciente, telefono, fecha, campos, radios, checks, alimentos, escalas, horarios }) {
  const c = k => String(campos[k] || "").trim();
  const ch = k => listaSegura(checks[k]).join(" · ");
  const rp = k => prettyVal(k, radios[k] || "");
  const u = (v, s) => v ? v + s : "";
  const L = [], add = (t) => L.push(t), sec = t => { L.push(""); L.push(t); };
  const sch = buildScheduleSummary(horarios);
  const plano = h => String(h || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  const join = (...xs) => xs.filter(Boolean).join(" · ");
  add(`FICHA DE INGRESO — ${nombre}`);
  add(join(fecha, emailPaciente, telefono));
  sec("DATOS BÁSICOS");
  add(join(u(c("Edad calculada"), " años"), radios.sexo === "M" ? "Hombre" : radios.sexo === "F" ? "Mujer" : "", u(c("Peso actual (kg)"), " kg"), u(c("Estatura (cm)"), " cm")));
  add(join(c("IMC Calculado") && "IMC " + c("IMC Calculado"), u(c("% Grasa corporal"), " % grasa"), rp("somatotipo") && "Somatotipo: " + rp("somatotipo")));
  add(join(u(c("Cintura (cm)"), " cm cintura"), u(c("Cadera (cm)"), " cm cadera"), c("Relación Cintura/Cadera") && "WHR " + c("Relación Cintura/Cadera")));
  add(join(c("Ocupación / Profesión"), c("Ciudad"), c("Fecha de nacimiento") && "Nacimiento " + c("Fecha de nacimiento")));
  sec("EVALUACIÓN DEL FORMULARIO (orientativa: recalcular con el módulo 01)");
  add(join(rp("actividad") && "Vida diaria: " + rp("actividad"), u(c("Tasa Metabólica Basal"), " kcal TMB"), u(c("Gasto Energético Total"), " kcal GET"), u(c("Proteína Recomendada"), " g proteína"), u(c("Agua Recomendada"), " ml agua")));
  const bio = [["Glucosa", "Glucosa en ayunas (mg/dL)", " mg/dL"], ["HbA1c", "HbA1c (%)", " %"], ["Colesterol", "Colesterol total (mg/dL)", " mg/dL"], ["HDL", "HDL (mg/dL)", ""], ["LDL", "LDL (mg/dL)", ""], ["TGL", "Triglicéridos (mg/dL)", " mg/dL"], ["TSH", "TSH (mIU/L)", " mIU/L"], ["Vitamina D", "Vitamina D (ng/mL)", " ng/mL"], ["Testosterona", "Testosterona total (ng/dL)", " ng/dL"], ["Estradiol", "Estradiol (pg/mL)", " pg/mL"]]
    .filter(([, k]) => c(k)).map(([n, k, s]) => n + " " + c(k) + s);
  sec("BIOMARCADORES"); add(bio.length ? bio.join(" · ") : "No informados");
  add(join(u(c("FC en reposo (lpm)"), " lpm FC reposo"), u(c("FC máxima estimada"), " lpm FCmáx (Tanaka)")));
  sec("BIENESTAR");
  add(join(escalas.energia && "Energía " + escalas.energia + "/10", escalas.sueno && "Sueño " + escalas.sueno + "/10", c("Horas de sueño promedio") && "Horas: " + c("Horas de sueño promedio"), escalas.estres && "Estrés " + escalas.estres + "/10"));
  add("Problemas de sueño: " + (ch("Problemas específicos de sueño") || "ninguno"));
  sec("OBJETIVO");
  add(join(rp("objetivo"), u(c("Peso objetivo (kg)"), " kg objetivo"), u(c("Plazo deseado (semanas)"), " semanas")));
  if (c("Motivación principal")) add(`Motivación: "${c("Motivación principal")}"`);
  add(join(escalas.compromiso && "Compromiso " + escalas.compromiso + "/10", ch("Historial de dietas previas (¿qué has intentado?)") && "Historial: " + ch("Historial de dietas previas (¿qué has intentado?)")));
  if (c("¿Qué funcionó mejor en el pasado? ¿Qué fue lo peor?")) add(`Experiencia previa: "${c("¿Qué funcionó mejor en el pasado? ¿Qué fue lo peor?")}"`);
  sec("PATRÓN ALIMENTARIO Y LOGÍSTICA");
  add(join(rp("dieta") && "Dieta: " + rp("dieta"), "Exclusiones: " + (ch("Exclusiones alimentarias voluntarias") || "ninguna")));
  add(join(c('Alimentos "trigger" (que desencadenan atracones)') && "Trigger: " + c('Alimentos "trigger" (que desencadenan atracones)'), rp("preparacion") && "Preparación: " + rp("preparacion"), c("Frecuencia deseada") && "Cheat meals: " + c("Frecuencia deseada")));
  add(join(rp("comidas") && "Comidas/día: " + rp("comidas"), plano(sch.mealsText)));
  add(join(sch.trainingTime && "Entreno " + sch.trainingTime, rp("timing"), horarios["Horario de entrenamiento"]));
  add(join(plano(sch.pre) && "Pre: " + plano(sch.pre), plano(sch.post) && "Post: " + plano(sch.post)));
  add(join(ch("Antes de entrenar prefiere") && "Antes prefiere: " + ch("Antes de entrenar prefiere"), ch("Después de entrenar prefiere") && "Después prefiere: " + ch("Después de entrenar prefiere")));
  add(join(c("Presupuesto semanal alimentario (USD)") && "Presupuesto: " + c("Presupuesto semanal alimentario (USD)"), c("Tiempo disponible para cocinar (min/día)") && "Cocina: " + c("Tiempo disponible para cocinar (min/día)")));
  sec("SALUD");
  add("Condiciones: " + (ch("Condiciones médicas diagnosticadas") || "ninguna") + " · Medicación: " + (c("Lista de medicamentos / suplementos y dosis") || "ninguna"));
  add("Alergias: " + (ch("Alergias alimentarias conocidas") || "ninguna") + " · Síntomas GI: " + (ch("Síntomas gastrointestinales frecuentes") || "ninguno"));
  add("Ciclo menstrual: " + (radios.ciclo ? prettyVal("ciclo", radios.ciclo) : "N/A"));
  sec("ENTRENAMIENTO");
  add(join(rp("nivel-experiencia") && "Nivel: " + rp("nivel-experiencia"), radios["dias-entreno"] && (radios["dias-entreno"] === "0" ? "Aún no entrena" : radios["dias-entreno"] + " días/semana"), rp("duracion-sesion")));
  add(join(rp("equipamiento") && "Equipamiento: " + rp("equipamiento"), c("Nombre del gimnasio (si aplica)")));
  add("Lesiones activas: " + ([ch("Lesiones activas"), c("Especifique la lesión activa")].filter(Boolean).join(" — ") || "ninguna"));
  add("Historial de lesiones: " + (c("Lesiones pasadas relevantes (cirugías, fracturas, rehabilitaciones)") || "sin antecedentes"));
  const obs = cleanScheduleFallback(campos["Cualquier detalle extra que deba conocer sobre tu entrenamiento"]); if (obs) add("Observaciones: " + obs);
  sec("PREFERENCIAS ALIMENTICIAS MARCADAS");
  for (const [cat, items] of Object.entries(alimentos)) { const l = listaSegura(items); if (l.length) add(`${cat}: ${l.join(" · ")}`); }
  sec("SUPLEMENTACIÓN ACTUAL");
  add("Básicos: " + (ch("Suplementos básicos (seleccione los que toma actualmente)") || "ninguno"));
  add("Ergogénicos: " + (ch("Suplementos ergogénicos / Performance") || "ninguno"));
  add("PEDs: " + (radios.peds === "si" ? "sí, actualmente" : radios.peds === "anterior" ? "usó anteriormente" : "no") + (ch("Sustancias utilizadas (seleccione todas)") ? " · " + ch("Sustancias utilizadas (seleccione todas)") : "") + (c("Duración del uso") ? " · " + (DUR_PED[c("Duración del uso")] || c("Duración del uso")) : "") + (c("¿Monitoreo médico actual?") ? " · monitoreo: " + (MON_PED[c("¿Monitoreo médico actual?")] || c("¿Monitoreo médico actual?")) : ""));
  if (c("¿Hay algo más que debamos saber?")) { sec("INFORMACIÓN ADICIONAL"); add(c("¿Hay algo más que debamos saber?")); }
  const al = alertasClinicas({ campos, radios, checks, escalas });
  sec("ALERTAS PARA REVISAR (módulo 08)"); add(al.length ? al.map(([k, v]) => `${k}: ${v}`).join("\n") : "Ninguna detectada en el formulario");
  return L.filter((x, i) => x !== "" || L[i - 1] !== "").join("\n").trim();
}

function slugNombre(n) {
  return String(n || "paciente").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "paciente";
}
function base64Utf8(txt) {
  const bytes = new TextEncoder().encode(txt); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ═══════════════════════════════════════════════════════════════════════════
//  EMAIL DE CONFIRMACIÓN AL PACIENTE (marca IRONQx, sin datos clínicos)
// ═══════════════════════════════════════════════════════════════════════════
function primerNombre(n) { return String(n || "").trim().split(/\s+/)[0] || ""; }
function datosConfirmacion({ radios = {}, horarios = {}, fecha }) {
  const dias = radios["dias-entreno"];
  return {
    objetivo: prettyVal("objetivo", radios.objetivo || ""),
    entreno: dias === "0" ? "Aún no entrenas" : dias ? `${dias} días por semana` : "",
    comidas: prettyVal("comidas", radios.comidas || "") || horarios["Frecuencia de comidas"] || "",
    fecha: fecha || "",
  };
}
function buildConfirmEmail({ nombre, objetivo, entreno, comidas, fecha }) {
  const nombreH = esc(primerNombre(nombre));
  const fila = (k, v) => v ? `<tr><td valign="top" style="padding:8px 10px 8px 0;width:42%;border-bottom:1px solid ${T.LINE};font-family:${SANS};font-size:12px;color:${T.MUTED};">${k}</td><td valign="top" style="padding:8px 0;border-bottom:1px solid ${T.LINE};font-family:${SANS};font-size:14px;color:${T.INK};">${esc(v)}</td></tr>` : "";
  const resumen = [fila("Tu objetivo", objetivo), fila("Entrenamiento", entreno), fila("Comidas al día", comidas), fila("Enviada el", fecha)].join("");
  const body = `
    ${rowT(`<p style="margin:0 0 4px;font-family:${SANS};font-size:15px;line-height:1.75;color:${T.SOFT};text-align:center;">Gracias por tomarte el tiempo de completarla con detalle. Ya está en mis manos y la trato con total confidencialidad.</p>`, "10px 30px 22px")}
    ${resumen ? rowT(cardT(`${kickerT("Lo que me contaste")}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${resumen}</table>`, { pad: "16px 18px 8px" }), "0 26px 18px") : ""}
    ${rowT(cardT(`${kickerT("Lo que sigue")}<div style="height:12px;line-height:12px;font-size:0;">&nbsp;</div>${stepsT([
      "<b style=\"color:#ECEEF4;\">Reviso tu ficha completa</b>: tu historia, tus hábitos y lo que sí te gusta comer.",
      "<b style=\"color:#ECEEF4;\">Diseño tu entrenamiento y tu nutrición</b> a tu medida, con tus horarios.",
      "<b style=\"color:#ECEEF4;\">Te aviso cuando tu plan esté listo</b> en tu app IronQx, en 24 a 48 horas hábiles.",
    ])}`, { gold: true, pad: "18px 18px" }), "0 26px 20px")}
    ${rowT(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:3px solid ${T.GOLD};padding:4px 0 4px 16px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.55;color:${T.INK};">Un plan que sí cumples vale más que uno perfecto que no sostienes. Vamos paso a paso.</td></tr></table>`, "4px 30px 22px")}
    ${rowT(`<div style="font-family:${SANS};font-size:13px;line-height:1.7;color:${T.MUTED};text-align:center;">¿Olvidaste algo o quieres agregar un detalle? <b style="color:${T.SOFT};">Responde a este correo</b> y lo sumo a tu ficha.</div>`, "0 30px 20px")}
    ${rowT(`<div style="text-align:center;"><div style="font-family:${SANS};font-size:13px;color:${T.MUTED};">Con aprecio,</div>
      <div style="margin-top:6px;font-family:${SERIF};font-size:22px;font-style:italic;color:${T.GOLD_LT};">Dr. Daniel Arévalo</div>
      <div style="margin-top:4px;font-family:${SANS};font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:${T.MUTED};">IRONQx · Clinical &amp; Performance</div></div>`, "4px 30px 6px")}`;
  return docShell({
    title: "Recibimos tu ficha · IRONQx",
    preheader: "Tu ficha llegó bien. En 24 a 48 horas hábiles tendrás tu plan en tu app IronQx.",
    kicker: "Ficha recibida",
    name: nombreH ? `${nombreH},` : "",
    heading: "Recibimos tu ficha",
    body, width: 560,
    footer: "Tu información es confidencial y solo la usa tu coach para diseñar tu plan.<br>Este es un mensaje automático de confirmación.",
  });
}
function confirmText({ nombre, objetivo, entreno, comidas, fecha }) {
  return [
    `${primerNombre(nombre) || "Hola"}, recibimos tu ficha.`, "",
    "Gracias por tomarte el tiempo de completarla con detalle. Ya está en mis manos y la trato con total confidencialidad.", "",
    objetivo || entreno || comidas ? "LO QUE ME CONTASTE" : "",
    objetivo ? "Tu objetivo: " + objetivo : "", entreno ? "Entrenamiento: " + entreno : "", comidas ? "Comidas al día: " + comidas : "", fecha ? "Enviada el: " + fecha : "", "",
    "LO QUE SIGUE",
    "1. Reviso tu ficha completa.",
    "2. Diseño tu entrenamiento y tu nutrición a tu medida.",
    "3. Te aviso cuando tu plan esté listo en tu app IronQx (24 a 48 horas hábiles).", "",
    "¿Quieres agregar algo? Responde a este correo.", "",
    "Dr. Daniel Arévalo · IRONQx Clinical & Performance",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}
