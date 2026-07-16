// Public client configuration for the Unicorn Studio gallery + Supabase auth.
//
// SECURITY NOTE: the Supabase ANON key below is a PUBLIC client key — the
// gallery web app already ships it to every browser, and Postgres RLS (not key
// secrecy) is what protects the data. It is therefore safe to embed in this
// desktop client. The same is true of the URLs. Do NOT ever put the Supabase
// SERVICE ROLE key or the gallery SETUP_TOKEN here — those are server-only.
//
// Each value falls back to a baked-in default (used by the packaged .dmg, where
// process.env is empty) but can be overridden at dev time via env vars.

export const GALLERY_URL = (
	process.env.UNICORN_GALLERY_URL ?? "https://unicorn-studio-gallery.vercel.app"
).replace(/\/+$/, "");

export const SUPABASE_URL = (
	process.env.UNICORN_SUPABASE_URL ?? "https://fplzpbwawatscljylimr.supabase.co"
).replace(/\/+$/, "");

export const SUPABASE_ANON_KEY =
	process.env.UNICORN_SUPABASE_ANON_KEY ??
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwbHpwYndhd2F0c2NsanlsaW1yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMjYwNzEsImV4cCI6MjA5MzcwMjA3MX0.nvR2hS0sE27sKdmiCYVBfLtAqOjA47Me-ngsi0IES1U";
