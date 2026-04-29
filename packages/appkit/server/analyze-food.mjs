export async function analyzeFoodHandler(req, res) {
  try {
    const apiKey = cleanString(req.body?.apiKey) || process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
    const image = cleanString(req.body?.image);

    if (!apiKey) {
      return res.status(400).json({ error: "Missing Anthropic API key" });
    }
    if (!image) {
      return res.status(400).json({ error: "Missing image data" });
    }

    const source = parseDataUrl(image);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        temperature: 0.1,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source },
              {
                type: "text",
                text:
                  "Identify the food in this image for a personal meal log. " +
                  "Return only valid JSON with keys: title, emoji, ingredients, portion, tags, notes. " +
                  "ingredients must be lowercase strings. portion must be small, medium, or large. " +
                  "tags can include breakfast, lunch, dinner, snack. If uncertain, use notes.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: "Anthropic request failed",
        detail: text.slice(0, 500),
      });
    }

    const payload = await response.json();
    const text = payload.content?.find((part) => part.type === "text")?.text;
    return res.json({ model, meal: normalizeMeal(parseJsonText(text)) });
  } catch (error) {
    return res.status(500).json({
      error: "Food analysis failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/);
  if (!match) {
    throw new Error("image must be a base64 data URL with png, jpeg, gif, or webp media type");
  }
  return {
    type: "base64",
    media_type: match[1] === "image/jpg" ? "image/jpeg" : match[1],
    data: match[2],
  };
}

function parseJsonText(text) {
  if (!text) throw new Error("Anthropic response did not include text");
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

function normalizeMeal(input) {
  const portion = ["small", "medium", "large"].includes(input?.portion) ? input.portion : "medium";
  return {
    title: cleanString(input?.title) || "Meal from photo",
    emoji: cleanString(input?.emoji) || "🍽",
    ingredients: Array.isArray(input?.ingredients)
      ? input.ingredients.map((item) => cleanString(item).toLowerCase()).filter(Boolean).slice(0, 20)
      : [],
    portion,
    tags: Array.isArray(input?.tags)
      ? input.tags.map((item) => cleanString(item).toLowerCase()).filter(Boolean).slice(0, 4)
      : [],
    notes: cleanString(input?.notes),
  };
}
