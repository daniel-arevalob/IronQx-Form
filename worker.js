// ═══════════════════════════════════════════════════════════════════════════
//  IRONQx · Cloudflare Worker — Form → Resend Email
//  Pegar completo en el editor de Cloudflare Workers
//  Variable de entorno requerida: RESEND_API_KEY  (tipo Secret)
// ═══════════════════════════════════════════════════════════════════════════

const TO_EMAIL   = "ironqx.coach@gmail.com";   // ← tu email
const FROM_EMAIL = "formulario@ironqx.fit"; // ← debe estar verificado en Resend
const FROM_NAME  = "IRONQx · Formulario";

// ─── CORS ────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ─── Entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST")   return new Response("Method not allowed", { status: 405 });

    try {
      const data = await request.json();
      const { campos = {}, radios = {}, checks = {}, alimentos = {}, escalas = {}, contacto = {}, metadata = {} } = data;

      // ── Anti-spam: honeypot + time-trap. Si se dispara, fingimos éxito
      //    y descartamos en silencio (el bot no reintenta).
      const fillMs = Number(metadata.fillMs);
      const tooFast = Number.isFinite(fillMs) && fillMs < 4000; // <4s = bot
      if (data.hp || data.website || campos["_gotcha"] || tooFast) {
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...CORS },
        });
      }

      // Fallback robusto: usa contacto (extracción directa) o busca en campos normalizados
      const nombre        = contacto.nombre   || campos["Nombre completo"]       || campos["Nombre"]      || "Paciente";
      const emailPaciente = contacto.email    || campos["Correo electrónico"]    || campos["Correo"]      || "";
      const telefono      = contacto.telefono || campos["Teléfono"]              || campos["Telefono"]    || "";
      const fecha         = metadata.fecha || new Date().toLocaleDateString("es-EC");

      // Validación de email server-side: si es inválido NO rompemos el envío,
      // solo omitimos reply_to/cc para no perder el lead.
      const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPaciente);

      const emailHtml = buildEmail({ nombre, emailPaciente, telefono, fecha, campos, radios, checks, alimentos, escalas });

      const resendBody = {
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to:   [TO_EMAIL],
        reply_to: emailValido ? emailPaciente : undefined,
        subject: oneLine(`📋 IRONQx — ${nombre} · ${fecha}`),
        html: emailHtml,
      };
      // Copia al paciente solo si el correo es válido
      if (emailValido) resendBody.cc = [emailPaciente];

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(resendBody),
      });

      if (!resendRes.ok) {
        const err = await resendRes.text();
        // Log completo en Cloudflare (wrangler tail / dashboard), respuesta genérica al cliente.
        console.error("Resend error:", resendRes.status, err);
        throw new Error("RESEND_FAIL");
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", ...CORS },
      });

    } catch (err) {
      console.error("Worker error:", err && err.stack ? err.stack : err);
      return new Response(JSON.stringify({
        success: false,
        error: "No se pudo enviar el formulario. Intenta de nuevo en unos minutos.",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }
  },
};

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
  actividad: {
    "1.2":   "Sedentario (poco o nada de ejercicio)",
    "1.375": "Ligero (1-3 días/semana)",
    "1.55":  "Moderado (3-5 días/semana)",
    "1.725": "Intenso (6-7 días/semana)",
    "1.9":   "Muy intenso (físico / 2x día)",
  },
  objetivo: {
    perdida_grasa:     "Pérdida de grasa corporal",
    ganancia_muscular: "Ganancia de masa muscular",
    recomposicion:     "Recomposición corporal",
    mantenimiento:     "Mantenimiento / Performance",
    salud:             "Mejora de salud general",
  },
  somatotipo: { ectomorfo: "Ectomorfo", mesomorfo: "Mesomorfo", endomorfo: "Endomorfo" },
  // (DUR_PED y MON_PED se usan aparte porque son campos select, no radios)
  equipamiento: {
    gym_completo: "Gym completo",
    gym_basico:   "Gym básico",
    casa:         "Casa",
    minimo:       "Equipamiento mínimo",
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
//  PLANTILLA DE EMAIL
// ═══════════════════════════════════════════════════════════════════════════

function buildEmail({ nombre, emailPaciente, telefono, fecha, campos, radios, checks, alimentos, escalas }) {
  // Todos los accesores ESCAPAN por defecto:
  const c  = k => esc(campos[k] || "");                       // texto/número
  const r  = k => esc(radios[k] || "");                       // radio crudo (para comparaciones M/F, si/no)
  const rp = k => esc(prettyVal(k, radios[k] || ""));         // radio con label legible
  const ch = k => checks[k] || [];                            // arrays: se escapan dentro de tagRow

  // Versiones escapadas de los datos de contacto para uso inline en el HTML
  const nombreH = esc(nombre), emailH = esc(emailPaciente), telH = esc(telefono);

  // IMC automático si hay datos (solo números → seguro)
  const imc = (() => {
    const h = parseFloat(campos["Estatura (cm)"]), w = parseFloat(campos["Peso actual (kg)"]);
    if (!h || !w) return "";
    const v = w / Math.pow(h / 100, 2);
    const cat = v < 18.5 ? "Bajo peso" : v < 25 ? "Normal" : v < 30 ? "Sobrepeso" : "Obesidad";
    const col = v < 18.5 ? "#4490ee" : v < 25 ? "#35b06a" : v < 30 ? "#d4a843" : "#d94f4f";
    return `<span style="font-weight:800;color:${col}">${v.toFixed(1)}</span> <span style="color:#888;font-size:11px">(${cat})</span>`;
  })();

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IRONQx · Formulario de Ingreso</title>
</head>
<body style="margin:0;padding:0;background:#f2f3f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">

  <!-- ▸ HEADER ──────────────────────────────────────────────────────────── -->
  <tr><td style="background:linear-gradient(135deg,#0d0e10 0%,#1a1d24 100%);
    border-radius:16px 16px 0 0;padding:36px 40px;text-align:center">
    <div style="font-size:36px;font-weight:900;letter-spacing:7px;color:#d4a843;
      text-shadow:0 2px 20px rgba(212,168,67,0.4)">
      IRON<span style="color:#c8cdd8">Qx</span>
    </div>
    <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;
      color:#7a7f8e;margin-top:4px">
      Clinical &amp; Performance Coaching
    </div>
    <div style="margin-top:20px;display:inline-block;padding:8px 20px;
      background:rgba(212,168,67,0.12);border:1px solid rgba(212,168,67,0.35);
      border-radius:20px">
      <span style="font-size:13px;font-weight:700;color:#d4a843;letter-spacing:1px">
        📋 Nuevo Formulario de Ingreso — Protocolo 2026
      </span>
    </div>
  </td></tr>

  <!-- ▸ RESUMEN EJECUTIVO ──────────────────────────────────────────────── -->
  ${resumenEjecutivo({ nombreH, imc, r, rp, c, escalas })}

  <!-- ▸ META STRIP ──────────────────────────────────────────────────────── -->
  <tr><td style="background:#1e2028;padding:12px 40px;border-left:1px solid #2a2d36;
    border-right:1px solid #2a2d36">
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="color:#7a7f8e;font-size:12px">
        Paciente: <strong style="color:#e8e8e8;font-size:13px">${nombreH}</strong>
      </td>
      <td align="right" style="color:#7a7f8e;font-size:12px">
        ${esc(fecha)}
      </td>
    </tr>
    ${emailH ? `<tr><td colspan="2" style="color:#7a7f8e;font-size:11px;padding-top:3px">
      ✉ ${emailH}${telH ? `&nbsp;&nbsp;·&nbsp;&nbsp;📱 ${telH}` : ""}
    </td></tr>` : telH ? `<tr><td colspan="2" style="color:#7a7f8e;font-size:11px;padding-top:3px">
      📱 ${telH}
    </td></tr>` : ""}
    </table>
  </td></tr>

  <!-- ▸ BODY ────────────────────────────────────────────────────────────── -->
  <tr><td style="background:#ffffff;padding:0;border:1px solid #e4e6eb;
    border-top:none;border-radius:0 0 16px 16px;overflow:hidden">

    <table width="100%" cellpadding="0" cellspacing="0">

      <!-- 01 · CONTACTO -->
      ${bloque("01", "Datos de Contacto", "👤", [
        fila("Nombre",       nombreH),
        fila("Teléfono",     telH || c("Teléfono")),
        fila("Correo",       emailH || c("Correo electrónico")),
        fila("Ciudad",       c("Ciudad")),
        fila("Nacimiento",   c("Fecha de nacimiento")),
        fila("Edad",         c("Edad calculada") ? c("Edad calculada") + " años" : ""),
        fila("Ocupación",    c("Ocupación / Profesión")),
      ])}

      <!-- 02 · FÍSICO -->
      ${bloque("02", "Datos Físicos", "⚖️", [
        fila("Estatura",     c("Estatura (cm)") ? c("Estatura (cm)") + " cm" : ""),
        fila("Peso actual",  c("Peso actual (kg)") ? c("Peso actual (kg)") + " kg" : ""),
        fila("Sexo",         r("sexo") === "M" ? "Masculino" : r("sexo") === "F" ? "Femenino" : c("Sexo") === "M" ? "Masculino" : c("Sexo") === "F" ? "Femenino" : ""),
        `<tr><td style="padding:6px 0;color:#666;font-size:12px;width:42%;vertical-align:top">IMC</td>
         <td style="padding:6px 0;font-size:13px;vertical-align:top">${imc || "—"}</td></tr>`,
        fila("Somatotipo",   rp("somatotipo")),
        fila("% Grasa",      c("% Grasa corporal") ? c("% Grasa corporal") + "%" : ""),
        fila("Cintura",      c("Cintura (cm)") ? c("Cintura (cm)") + " cm" : ""),
        fila("Cadera",       c("Cadera (cm)") ? c("Cadera (cm)") + " cm" : ""),
        fila("C/C",          c("Relación Cintura/Cadera")),
      ])}

      <!-- 03 · ENTRENAMIENTO -->
      ${bloque("03", "Entrenamiento", "🏋️", [
        fila("Nivel",        rp("nivel-experiencia")),
        fila("Días/semana",  c("Días/semana") || r("dias-entreno")),
        fila("Equipamiento", rp("equipamiento")),
        fila("Gimnasio",     c("Nombre del gimnasio (si aplica)")),
        ch("Lesiones activas").length ? tagRow("Lesiones activas", ch("Lesiones activas"), "#d94f4f") : "",
        c("Especifique la lesión activa") ? fila("Detalle lesión", c("Especifique la lesión activa")) : "",
        c("Lesiones pasadas relevantes (cirugías, fracturas, rehabilitaciones)") ?
          fila("Historial", c("Lesiones pasadas relevantes (cirugías, fracturas, rehabilitaciones)")) : "",
        c("Cualquier detalle extra que deba conocer sobre tu entrenamiento") ?
          fila("Observaciones", c("Cualquier detalle extra que deba conocer sobre tu entrenamiento")) : "",
      ])}

      <!-- 04 · SALUD -->
      ${bloque("04", "Salud", "🏥", [
        tagRow("Condiciones médicas", ch("Condiciones médicas diagnosticadas"), "#d94f4f"),
        c("Lista de medicamentos / suplementos y dosis") ? fila("Medicamentos", c("Lista de medicamentos / suplementos y dosis")) : "",
        tagRow("Alergias alimentarias", ch("Alergias alimentarias conocidas"), "#d4a843"),
        tagRow("Síntomas gastrointestinales", ch("Síntomas gastrointestinales frecuentes"), "#d4a843"),
      ])}

      <!-- 05 · ALIMENTACIÓN -->
      ${bloque("05", "Patrón Alimentario", "🍽️", [
        fila("Patrón principal", rp("dieta")),
        tagRow("Exclusiones voluntarias", ch("Exclusiones alimentarias voluntarias"), "#888"),
      ])}

      <!-- 06–09 · ALIMENTOS SELECCIONADOS -->
      ${Object.values(alimentos).some(arr => arr.length > 0) ? bloqueAlimentos(alimentos) : ""}

      <!-- 10 · METABOLISMO -->
      ${bloque("10", "Metabolismo", "⚡", [
        fila("Nivel de actividad",  rp("actividad")),
        fila("FC reposo",           c("FC en reposo (lpm)") ? c("FC en reposo (lpm)") + " lpm" : ""),
        fila("FC máxima",           c("FC máxima estimada") ? c("FC máxima estimada") + " lpm" : ""),
        fila("Zona aeróbica",       c("Zona aeróbica (60-70%)")),
        fila("Zona quema grasa",    c("Zona quema grasa (70-80%)")),
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
      ${bloque("11", "Bienestar y Recuperación", "📊", [
        escalaRow("Energía diaria",    escalas.energia),
        escalaRow("Calidad del sueño", escalas.sueno),
        escalaRow("Nivel de estrés",   escalas.estres),
        fila("Horas de sueño",         c("Horas de sueño promedio")),
        tagRow("Problemas de sueño",   ch("Problemas específicos de sueño"), "#888"),
      ])}

      <!-- 12 · OBJETIVOS -->
      ${bloque("12", "Objetivos", "🎯", [
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
      ${bloque("13", "Logística del Plan", "📋", [
        fila("Frecuencia de comidas",  rp("comidas")),
        fila("Horario entreno",        rp("timing")),
        fila("Estilo preparación",     rp("preparacion")),
        fila("Cheat meals",            c("Frecuencia deseada")),
        fila("Presupuesto semanal",    c("Presupuesto semanal alimentario (USD)")),
        fila("Tiempo para cocinar",    c("Tiempo disponible para cocinar (min/día)")),
        fila("Alimentos trigger",      c("Alimentos \"trigger\" (que desencadenan atracones)")),
      ])}

      <!-- 14 · SUPLEMENTOS -->
      ${bloque("14", "Suplementación y PEDs", "💊", [
        tagRow("Suplementos básicos",     ch("Suplementos básicos (seleccione los que toma actualmente)"), "#35b06a"),
        tagRow("Ergogénicos",             ch("Suplementos ergogénicos / Performance"), "#35b06a"),
        fila("Uso de PEDs",               r("peds") === "si" ? "✅ Sí usa PEDs"
                                        : r("peds") === "no" ? "❌ No usa PEDs"
                                        : r("peds") || "No indicado"),
        tagRow("Sustancias utilizadas",   ch("Sustancias utilizadas (seleccione todas)"), "#d94f4f"),
        fila("Duración del uso",          esc(DUR_PED[campos["Duración del uso"]] || campos["Duración del uso"] || "")),
        fila("Monitoreo médico",          esc(MON_PED[campos["¿Monitoreo médico actual?"]] || campos["¿Monitoreo médico actual?"] || "")),
        fila("Esquema PEDs",              c("Detalles adicionales / Esquema aproximado")),
        fila("Ciclo menstrual",           r("ciclo") || r("ciclo-menstrual") || ""),
      ])}

      <!-- 15 · INFO ADICIONAL -->
      ${c("¿Hay algo más que debamos saber?") ? bloque("15", "Información Adicional", "💬", [
        `<tr><td colspan="2" style="padding:6px 0;font-size:13px;color:#333;line-height:1.7">
          ${c("¿Hay algo más que debamos saber?")}
        </td></tr>`,
      ]) : ""}

      <!-- FIRMA -->
      ${c("Firma digital (escriba su nombre completo)") ? `
      <tr><td style="padding:0 32px 24px">
        <table width="100%" cellpadding="0" cellspacing="0"
          style="background:#f8f9fb;border:1px solid #e4e6eb;border-radius:10px;padding:16px">
        <tr>
          <td style="font-size:12px;color:#666">
            Firma digital: <strong style="color:#333">${c("Firma digital (escriba su nombre completo)")}</strong>
          </td>
          <td align="right" style="font-size:12px;color:#666">
            ${c("Fecha") || esc(fecha)}
          </td>
        </tr>
        </table>
      </td></tr>` : ""}

    </table><!-- /body table -->

  </td></tr>

  <!-- ▸ FOOTER ──────────────────────────────────────────────────────────── -->
  <tr><td style="padding:24px;text-align:center">
    <div style="font-size:10px;color:#aaa;letter-spacing:1px;line-height:1.8">
      <strong style="color:#d4a843">IRONQx</strong> · Clinical &amp; Performance Coaching<br>
      Protocolo 2026 · La información es estrictamente confidencial.<br>
      Este correo fue generado automáticamente al enviar el formulario.
    </div>
  </td></tr>

</table><!-- /outer -->
</td></tr>
</table><!-- /wrapper -->
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS DE PLANTILLA
// ═══════════════════════════════════════════════════════════════════════════

/** Tarjeta de resumen ejecutivo: lo más relevante de un vistazo (5 segundos). */
function resumenEjecutivo({ nombreH, imc, r, rp, c, escalas }) {
  const objetivo = rp("objetivo");
  const get      = c("Gasto Energético Total");
  const prote    = c("Proteína Recomendada");
  const dias     = r("dias-entreno");

  const chip = (label, valor) => valor
    ? `<td style="padding:6px 10px;vertical-align:top">
         <div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#7a7f8e">${label}</div>
         <div style="font-size:14px;font-weight:800;color:#d4a843;margin-top:2px">${valor}</div>
       </td>`
    : "";

  const chips = [
    chip("Objetivo", objetivo),
    chip("IMC", imc),
    chip("GET", get ? get + " kcal" : ""),
    chip("Proteína", prote ? prote + " g" : ""),
    chip("Entreno", dias ? dias + " d/sem" : ""),
  ].filter(Boolean).join("");

  if (!chips) return "";

  return `<tr><td style="background:#15171d;padding:14px 30px;border-left:1px solid #2a2d36;border-right:1px solid #2a2d36">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>${chips}</tr></table>
  </td></tr>`;
}

/** Bloque de sección con número, título e ícono */
function bloque(num, titulo, icono, filas) {
  const contenido = filas.filter(Boolean).join("");
  if (!contenido.replace(/<[^>]*>/g, "").trim()) return "";
  return `
  <tr><td style="padding:0 32px 24px">
    <!-- header de sección -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:1px">
    <tr>
      <td style="background:#0d0e10;border-radius:10px 10px 0 0;padding:10px 18px">
        <span style="font-size:18px;font-weight:900;color:#d4a843;margin-right:6px">${num}</span>
        <span style="font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;
          color:#e8e8e8">${icono} ${titulo}</span>
      </td>
    </tr>
    </table>
    <!-- contenido de sección -->
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#fafafa;border:1px solid #e4e6eb;border-top:2px solid #d4a843;
      border-radius:0 0 10px 10px;padding:14px 18px">
      ${contenido}
    </table>
  </td></tr>`;
}

/** Fila clave → valor. El valor debe venir YA escapado (vía c()/r()/rp() o esc()). */
function fila(label, valor) {
  if (!valor || String(valor).trim() === "") return "";
  return `<tr>
    <td style="padding:5px 0;color:#888;font-size:12px;width:42%;vertical-align:top">${label}</td>
    <td style="padding:5px 0;color:#1a1a1a;font-size:13px;font-weight:500;vertical-align:top">${valor}</td>
  </tr>`;
}

/** Fila con tags de colores. Escapa cada item (datos de usuario). */
function tagRow(label, items, color) {
  if (!items?.length) return "";
  const tags = items.map(i =>
    `<span style="display:inline-block;margin:2px 3px 2px 0;padding:3px 10px;
      background:${color}18;border:1px solid ${color}55;border-radius:20px;
      font-size:11px;color:${color};font-weight:600">${esc(i)}</span>`
  ).join("");
  return `<tr>
    <td style="padding:6px 0;color:#888;font-size:12px;width:42%;vertical-align:top">${label}</td>
    <td style="padding:6px 0;vertical-align:top">${tags}</td>
  </tr>`;
}

/** Fila de escala 1-10 con barra visual */
function escalaRow(label, valor) {
  if (!valor) return "";
  const n = parseInt(valor) || 0;
  const color = n <= 3 ? "#d94f4f" : n <= 6 ? "#d4a843" : "#35b06a";
  const barra = Array.from({ length: 10 }, (_, i) =>
    `<span style="display:inline-block;width:18px;height:7px;border-radius:2px;
      margin-right:2px;background:${i < n ? color : "#e4e6eb"}"></span>`
  ).join("");
  return `<tr>
    <td style="padding:6px 0;color:#888;font-size:12px;width:42%;vertical-align:middle">${label}</td>
    <td style="padding:6px 0;vertical-align:middle">
      <span style="font-weight:800;font-size:14px;color:${color};margin-right:8px">${esc(valor)}/10</span>
      ${barra}
    </td>
  </tr>`;
}

/** Bloque especial de alimentos seleccionados */
function bloqueAlimentos(alimentos) {
  const iconos = {
    "Proteínas": "🥩", "Carbohidratos": "🍚",
    "Grasas": "🥑", "Vegetales": "🥬", "Frutas": "🍎"
  };
  const colores = {
    "Proteínas": "#4490ee", "Carbohidratos": "#d4a843",
    "Grasas": "#35b06a", "Vegetales": "#35b06a", "Frutas": "#d94f4f"
  };

  const categorias = Object.entries(alimentos)
    .filter(([, items]) => items.length > 0)
    .map(([cat, items]) => {
      const color = colores[cat] || "#888";
      const icono = iconos[cat] || "•";
      const tags = items.map(i =>
        `<span style="display:inline-block;margin:2px 3px 2px 0;padding:3px 10px;
          background:${color}14;border:1px solid ${color}44;border-radius:20px;
          font-size:11px;color:${color};font-weight:600">✓ ${esc(i)}</span>`
      ).join("");
      return `
        <td style="padding:0 12px 16px 0;vertical-align:top;width:50%">
          <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;
            text-transform:uppercase;color:${color};margin-bottom:8px">
            ${icono} ${esc(cat)} <span style="font-weight:400;color:#aaa">(${items.length})</span>
          </div>
          <div>${tags}</div>
        </td>`;
    });

  if (!categorias.length) return "";

  // Agrupar en filas de 2 columnas
  let filas = "";
  for (let i = 0; i < categorias.length; i += 2) {
    filas += `<tr>${categorias[i]}${categorias[i + 1] || "<td></td>"}</tr>`;
  }

  return `
  <tr><td style="padding:0 32px 24px">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:1px">
    <tr>
      <td style="background:#0d0e10;border-radius:10px 10px 0 0;padding:10px 18px">
        <span style="font-size:18px;font-weight:900;color:#d4a843;margin-right:6px">06–09</span>
        <span style="font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;
          color:#e8e8e8">🍱 Preferencias Alimentarias</span>
      </td>
    </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0"
      style="background:#fafafa;border:1px solid #e4e6eb;border-top:2px solid #d4a843;
      border-radius:0 0 10px 10px;padding:18px 18px 2px">
      ${filas}
    </table>
  </td></tr>`;
}
