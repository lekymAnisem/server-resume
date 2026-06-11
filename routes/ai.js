import { Router } from "express"
import auth from "../middleware/auth.js"
import Resume from "../models/Resume.js"

const router = Router()

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions"

async function groq(system, user) {
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
      temperature: 0.7,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || `AI request failed (${res.status})`)
  if (!data.choices?.[0]?.message?.content) throw new Error("Empty AI response")
  return data.choices[0].message.content
}

function parseJSON(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("No JSON object found in AI response")
  return JSON.parse(cleaned.slice(start, end + 1))
}

router.post("/generate", auth, async (req, res) => {
  try {
    const { jobTitle, industry, experienceLevel, highlights } = req.body

    const system = `You are an expert resume writer. Generate a complete JSON Resume following the JSON Resume Schema (https://jsonresume.org/schema). Return ONLY valid JSON, no explanations, no markdown formatting. Use realistic placeholder data matching the user's inputs.

Required structure:
{
  "basics": { "name": "...", "label": "...", "email": "...", "phone": "...", "summary": "...", "location": { "city": "...", "region": "..." }, "profiles": [] },
  "work": [ { "name": "Company", "position": "Title", "startDate": "YYYY-MM", "endDate": "YYYY-MM or Present", "summary": "..." } ],
  "education": [ { "institution": "...", "area": "...", "studyType": "...", "startDate": "YYYY-MM", "endDate": "YYYY-MM" } ],
  "skills": [ { "name": "...", "level": "..." } ],
  "projects": [ { "name": "Project Name", "description": "Brief project impact and technologies used.", "url": "", "startDate": "YYYY-MM", "endDate": "YYYY-MM", "highlights": ["Measurable result or feature delivered"] } ],
  "languages": []
}`

    const user = `Generate a resume for:
Job Title: ${jobTitle || "Not specified"}
Industry: ${industry || "Not specified"}
Experience Level: ${experienceLevel || "Mid-level"}
Key Highlights: ${highlights || "Not specified"}

Use realistic data that matches these details.`

    const raw = await groq(system, user)
    const data = parseJSON(raw)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/enhance", auth, async (req, res) => {
  try {
    const { section, content, context } = req.body

    const prompts = {
      summary: {
        system: "You are a professional resume editor. Rewrite the given professional summary to be more impactful, quantifiable, and ATS-friendly. Keep it 2-4 sentences. Return ONLY the rewritten summary text, no extra formatting.",
        user: `Current summary: "${content}"\nContext: ${context || "General professional role"}\n\nRewrite this summary to be more compelling and results-driven.`,
      },
      experience: {
        system: "You are a senior career coach. Rewrite the given work experience bullet points to be more achievement-oriented, quantify results, and use strong action verbs. Return ONLY the rewritten text, no extra formatting.",
        user: `Current description: "${content}"\nRole context: ${context || "Professional role"}\n\nRewrite this to highlight achievements and impact.`,
      },
      skills: {
        system: "You are an industry expert. Suggest relevant skills for the given role and industry. Return a comma-separated list of 8-12 skills ranked by relevance. ONLY the list, no extra text.",
        user: `Role/Industry: ${context || "General professional"}\nCurrent skills: ${content || "None specified"}\n\nSuggest relevant skills for this role.`,
      },
    }

    const prompt = prompts[section] || prompts.summary
    const result = await groq(prompt.system, prompt.user)
    res.json({ result: result.trim() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/rewrite", auth, async (req, res) => {
  try {
    const { resumeId, instructions } = req.body

    const resume = await Resume.findOne({ _id: resumeId, user: req.userId })
    if (!resume) return res.status(404).json({ error: "Resume not found" })

    const system = `You are an expert resume writer. The user will provide their current resume data in JSON Resume format and instructions for improvement. Return the COMPLETE updated resume JSON with all changes applied. Keep all fields that don't need changing. Return ONLY valid JSON inside a code block.`

    const user = `Current Resume JSON:\n${JSON.stringify(resume.data, null, 2)}\n\nUser Instructions: ${instructions}\n\nReturn the complete updated resume JSON.`

    const raw = await groq(system, user)
    const data = parseJSON(raw)

    resume.data = data
    await resume.save()

    res.json(resume)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
