import { Router } from "express"
import { createRequire } from "module"
import mongoose from "mongoose"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import multer from "multer"
import sharp from "sharp"
import auth from "../middleware/auth.js"
import Resume from "../models/Resume.js"

const require = createRequire(import.meta.url)
const router = Router()

const upload = multer({ dest: "/tmp/resume-uploads" })
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
})

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions"

async function groqParse(system, user) {
  const res = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || "AI request failed")
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error("Empty AI response")
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("No JSON found in AI response")
  return JSON.parse(cleaned.slice(start, end + 1))
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR = path.join(__dirname, "..", "docs")

if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true })
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id)
}

const themes = {
  elegant: "jsonresume-theme-elegant",
  flat: "jsonresume-theme-flat",
  modern: "jsonresume-theme-modern",
}

function getDefaultData() {
  return {
    basics: {
      name: "", label: "", email: "", phone: "", url: "", summary: "",
      location: { address: "", postalCode: "", city: "", countryCode: "", region: "" },
      profiles: [],
    },
    work: [], education: [], skills: [], projects: [],
    languages: [], interests: [], volunteer: [],
    awards: [], publications: [], references: [], certificates: [],
  }
}

function fixThemeHtml(html) {
  let result = html
    .replace(/http:\/\/bootswatch\.com\/lumen\/bootstrap\.min\.css/g, "https://cdn.jsdelivr.net/npm/bootswatch@3.3.7/lumen/bootstrap.min.css")
    .replace(/http:\/\/([a-z]+\.(?:bootstrapcdn|bootswatch|googleapis)\.com)/g, "https://$1")

  if (result.includes("bootswatch") && !result.includes("section header h3")) {
    const cssPath = path.join(__dirname, "..", "node_modules", "jsonresume-theme-modern", "resume.css")
    if (fs.existsSync(cssPath)) {
      const themeCss = fs.readFileSync(cssPath, "utf-8")
      result = result.replace(/<style>\s*<\/style>/, `<style>${themeCss}</style>`)
    }
  }

  return result
}

function addResumeOutputStyles(html) {
  const styles = `
    <style>
      .media-object.img-circle {
        background: #f7f8fb;
        object-fit: cover;
      }

      #projects .project-item,
      #projects-experience .card-nested {
        overflow-wrap: anywhere;
        word-break: normal;
      }

      #projects .project-item {
        margin-bottom: 18px;
      }

      #projects .project-heading {
        align-items: flex-start;
        border-top: 1px solid #f4f6f6;
        display: flex;
        gap: 16px;
        justify-content: space-between;
        line-height: 1.35;
        margin: 12px 0 6px;
        padding-top: 8px;
      }

      #projects .project-title {
        font-size: 16px;
        font-weight: 700;
        min-width: 0;
      }

      #projects .project-date {
        color: #95a5a6;
        flex: 0 0 auto;
        font-size: 13px;
        text-align: right;
        white-space: nowrap;
      }

      #projects .project-url {
        display: block;
        font-size: 13px;
        margin: 2px 0 8px;
        overflow-wrap: anywhere;
      }

      #projects .summary p {
        margin: 0 0 8px;
      }

      #projects .highlights {
        margin-top: 6px;
      }

      #projects-experience a,
      #projects a {
        overflow-wrap: anywhere;
      }

      @media (max-width: 640px) {
        #projects .project-heading {
          display: block;
        }

        #projects .project-date {
          display: block;
          margin-top: 4px;
          text-align: left;
          white-space: normal;
        }
      }
    </style>`

  if (html.includes("#projects .project-heading")) return html
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styles}\n</head>`)
  return `${styles}\n${html}`
}

async function enhancePortrait(buffer) {
  const width = 600
  const height = 760
  const source = sharp(buffer, { failOn: "none" }).rotate()
  const resized = await source
    .resize({ width, height, fit: "cover", position: sharp.strategy.attention })
    .modulate({ brightness: 1.04, saturation: 1.03 })
    .sharpen({ sigma: 0.7 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = Buffer.from(resized.data)
  const { channels } = resized.info
  const edgeSamples = []

  for (let y = 0; y < height; y += 8) {
    for (const x of [0, width - 1]) {
      const i = (y * width + x) * channels
      edgeSamples.push([pixels[i], pixels[i + 1], pixels[i + 2]])
    }
  }

  for (let x = 0; x < width; x += 8) {
    for (const y of [0, height - 1]) {
      const i = (y * width + x) * channels
      edgeSamples.push([pixels[i], pixels[i + 1], pixels[i + 2]])
    }
  }

  const bg = edgeSamples.reduce((sum, sample) => {
    sum[0] += sample[0]
    sum[1] += sample[1]
    sum[2] += sample[2]
    return sum
  }, [0, 0, 0]).map((value) => value / Math.max(edgeSamples.length, 1))
  const bgBrightness = (bg[0] + bg[1] + bg[2]) / 3

  if (bgBrightness > 105) {
    for (let i = 0; i < pixels.length; i += channels) {
      const distance = Math.hypot(pixels[i] - bg[0], pixels[i + 1] - bg[1], pixels[i + 2] - bg[2])
      if (distance < 48) {
        pixels[i + 3] = 0
      } else if (distance < 86) {
        pixels[i + 3] = Math.min(pixels[i + 3], Math.round(((distance - 48) / 38) * 255))
      }
    }
  }

  const cutout = await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer()
  const output = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#f7f8fb",
    },
  })
    .composite([{ input: cutout, gravity: "center" }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()

  return `data:image/jpeg;base64,${output.toString("base64")}`
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function projectHasContent(project) {
  return Boolean(
    project?.name ||
    project?.description ||
    project?.url ||
    project?.startDate ||
    project?.endDate ||
    (Array.isArray(project?.highlights) && project.highlights.some(Boolean))
  )
}

function renderFallbackProjects(projects) {
  const projectItems = projects.filter(projectHasContent)
  if (projectItems.length === 0) return ""

  const items = projectItems.map((project) => {
    const name = escapeHtml(project.name || "Project")
    const projectUrl = project.url ? escapeHtml(project.url) : ""
    const dates = [project.startDate, project.endDate].filter(Boolean).map(escapeHtml).join(" - ")
    const url = projectUrl
      ? `<a class="project-url" href="${projectUrl}" target="_blank" rel="noreferrer">${projectUrl}</a>`
      : ""
    const description = project.description
      ? `<div class="summary"><p>${escapeHtml(project.description)}</p></div>`
      : ""
    const highlights = Array.isArray(project.highlights) && project.highlights.some(Boolean)
      ? `<ul class="highlights">${project.highlights.filter(Boolean).map((highlight) => `<li>${escapeHtml(highlight)}</li>`).join("")}</ul>`
      : ""

    return `
      <div class="col-sm-12 project-item">
        <h4 class="project-heading">
          <span class="project-title">${name}</span>
          ${dates ? `<span class="project-date">${dates}</span>` : ""}
        </h4>
        ${url}
        ${description}
        ${highlights}
      </div>`
  }).join("")

  return `
    <section id="projects" class="row">
      <aside class="col-sm-3">
        <h3>Projects</h3>
      </aside>
      <div class="col-sm-9">
        <div class="row">
          ${items}
        </div>
      </div>
    </section>`
}

function ensureProjectsSection(html, resumeData) {
  const projects = Array.isArray(resumeData.projects) ? resumeData.projects : []
  const section = renderFallbackProjects(projects)
  if (!section || /id=["'](?:projects|projects-experience)["']/i.test(html)) return html

  if (/<section id=["']skills["']/i.test(html)) {
    return html.replace(/<section id=["']skills["'][\s\S]*$/i, (tail) => `${section}\n${tail}`)
  }

  return html.replace(/<\/body>/i, `${section}\n</body>`)
}

function applyModernPortrait(html, resumeData, themeName) {
  if (themeName !== "modern" || !resumeData.basics?.picture) return html

  return html.replace(
    /(<img\b[^>]*\bclass="[^"]*\bimg-circle\b[^"]*"[^>]*\bsrc=")[^"]*("[^>]*>)/i,
    `$1${resumeData.basics.picture}$2`
  )
}

function sanitizeResumeData(data, themeName) {
  const defaults = getDefaultData()
  const safe = { ...defaults, ...data }
  safe.basics = { ...defaults.basics, ...(data.basics || {}) }
  safe.basics.location = { ...defaults.basics.location, ...((data.basics && data.basics.location) || {}) }

  if (themeName === "modern" && safe.basics.name) {
    const parts = safe.basics.name.trim().split(/\s+/)
    safe.basics.firstName = parts[0] || ""
    safe.basics.lastName = parts.slice(1).join(" ") || ""
  }

  ;["work", "education", "skills", "projects", "languages", "interests", "volunteer", "awards", "publications", "references", "certificates", "profiles"].forEach((key) => {
    if (!Array.isArray(safe[key])) safe[key] = defaults[key] || []
  })

  safe.work = safe.work.map((w) => ({
    ...w,
    startDate: w.startDate || "",
    endDate: w.endDate || "",
    summary: w.summary || "",
    highlights: Array.isArray(w.highlights) ? w.highlights : [],
  }))

  safe.education = safe.education.map((e) => ({
    ...e,
    startDate: e.startDate || "",
    endDate: e.endDate || "",
  }))

  safe.skills = safe.skills.map((s) => ({
    ...s,
    name: s.name || "",
    level: s.level || "",
    keywords: Array.isArray(s.keywords) ? s.keywords : [],
  }))

  safe.projects = safe.projects.map((p) => ({
    ...p,
    name: p.name || "",
    description: p.description || p.summary || "",
    url: p.url || p.website || "",
    startDate: p.startDate || "",
    endDate: p.endDate || "",
    highlights: Array.isArray(p.highlights) ? p.highlights : [],
  }))

  safe.languages = safe.languages.map((l) => ({
    ...l,
    language: l.language || "",
    fluency: l.fluency || "",
  }))

  return safe
}

router.get("/", auth, async (req, res) => {
  try {
    const resumes = await Resume.find({ user: req.userId }).select("title theme createdAt updatedAt").sort({ updatedAt: -1 })
    res.json(resumes)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/photo/enhance", auth, photoUpload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" })
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Upload a valid image file" })
    }

    const picture = await enhancePortrait(req.file.buffer)
    res.json({
      picture,
      message: "Portrait enhanced for the Modern resume template",
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get("/:id", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid resume ID" })
    const resume = await Resume.findOne({ _id: req.params.id, user: req.userId })
    if (!resume) return res.status(404).json({ error: "Resume not found" })
    res.json(resume)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/", auth, async (req, res) => {
  try {
    const { title, theme, data } = req.body
    const resume = await Resume.create({
      user: req.userId,
      title: title || "My Resume",
      theme: theme || "elegant",
      data: data || getDefaultData(),
    })
    res.status(201).json(resume)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put("/:id", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid resume ID" })
    const { title, theme, data } = req.body
    const resume = await Resume.findOneAndUpdate(
      { _id: req.params.id, user: req.userId },
      { $set: { title, theme, data } },
      { new: true }
    )
    if (!resume) return res.status(404).json({ error: "Resume not found" })
    res.json(resume)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete("/:id", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid resume ID" })
    const resume = await Resume.findOneAndDelete({ _id: req.params.id, user: req.userId })
    if (!resume) return res.status(404).json({ error: "Resume not found" })
    res.json({ message: "Deleted" })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" })

    const ext = path.extname(req.file.originalname).toLowerCase()
    const filePath = req.file.path
    let parsed

    if (ext === ".json") {
      const raw = fs.readFileSync(filePath, "utf-8")
      parsed = JSON.parse(raw)
      if (!parsed.basics && !parsed.work && !parsed.skills) {
        throw new Error("File does not appear to be a valid JSON Resume")
      }
    } else {
      let text = ""
      if (ext === ".pdf") {
        const pdfjsLib = require("pdfjs-dist/legacy/build/pdf")
        const buf = fs.readFileSync(filePath)
        const data = new Uint8Array(buf)
        const doc = await pdfjsLib.getDocument({ data }).promise
        const pages = []
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i)
          const content = await page.getTextContent()
          pages.push(content.items.map(item => item.str).join(" "))
        }
        text = pages.join("\n")
      } else if (ext === ".docx") {
        const mammoth = await import("mammoth")
        const buf = fs.readFileSync(filePath)
        const result = await mammoth.extractRawText({ buffer: buf })
        text = result.value
      } else {
        fs.unlinkSync(filePath)
        return res.status(400).json({ error: "Unsupported file type. Use .json, .pdf, or .docx" })
      }

      const system = `You are a resume parser. Convert the following raw resume text into a valid JSON Resume (https://jsonresume.org/schema). Return ONLY valid JSON, no explanations, no markdown formatting. Include all fields: basics (name, label, email, phone, summary, location), work (company, position, startDate, endDate, summary, highlights), education (institution, area, studyType, startDate, endDate), skills (name, level, keywords), projects, languages, and any other sections you can identify. If a field is not found in the text, use an empty string or empty array.`

      const user = `Raw resume text:\n\n${text.slice(0, 8000)}`
      parsed = await groqParse(system, user)
    }

    const resume = await Resume.create({
      user: req.userId,
      title: parsed.basics?.name || req.file.originalname.replace(/\.[^.]+$/, ""),
      theme: "elegant",
      data: parsed,
    })

    fs.unlinkSync(filePath)
    res.status(201).json(resume)
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
    res.status(500).json({ error: err.message })
  }
})

router.post("/:id/export", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid resume ID" })
    const resume = await Resume.findOne({ _id: req.params.id, user: req.userId })
    if (!resume) return res.status(404).json({ error: "Resume not found" })

    const themeName = req.body.theme || resume.theme
    const themePkg = themes[themeName]
    if (!themePkg) {
      return res.status(400).json({ error: `Theme "${themeName}" not found. Available: ${Object.keys(themes).join(", ")}` })
    }

    let theme
    try {
      theme = require(themePkg)
    } catch {
      return res.status(500).json({ error: `Failed to load theme "${themeName}"` })
    }

    const safeData = sanitizeResumeData(resume.data, themeName)
    let html = theme.render(safeData)
    html = applyModernPortrait(html, safeData, themeName)
    html = fixThemeHtml(html)
    html = ensureProjectsSection(html, safeData)
    html = addResumeOutputStyles(html)
    res.json({ html, theme: themeName })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/:id/download", auth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid resume ID" })
    const resume = await Resume.findOne({ _id: req.params.id, user: req.userId })
    if (!resume) return res.status(404).json({ error: "Resume not found" })

    const themeName = req.body.theme || resume.theme
    const themePkg = themes[themeName]
    if (!themePkg) return res.status(400).json({ error: `Theme "${themeName}" not found` })

    let theme
    try {
      theme = require(themePkg)
    } catch {
      return res.status(500).json({ error: `Failed to load theme "${themeName}"` })
    }

    const safeData = sanitizeResumeData(resume.data, themeName)
    let html = theme.render(safeData)
    html = applyModernPortrait(html, safeData, themeName)
    html = fixThemeHtml(html)
    html = ensureProjectsSection(html, safeData)
    html = addResumeOutputStyles(html)
    const json = JSON.stringify(safeData, null, 2)

    const htmlPath = path.join(DOCS_DIR, "resume.html")
    const jsonPath = path.join(DOCS_DIR, "resume.json")
    fs.writeFileSync(htmlPath, html, "utf-8")
    fs.writeFileSync(jsonPath, json, "utf-8")

    res.download(htmlPath, "resume.html")
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
