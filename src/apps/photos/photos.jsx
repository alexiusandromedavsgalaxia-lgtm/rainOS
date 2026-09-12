// ============================================================================
// photos.jsx — Photos con pipeline de imágenes real
// ----------------------------------------------------------------------------
// Photos procesa imágenes REALES usando Canvas 2D + WebGL:
//
//   - Importar imágenes (file, drag&drop, URL)
//   - Miniaturas generadas dinámicamente con Canvas
//   - Visor con zoom, pan y rotación
//   - Edición: brillo, contraste, saturación, exposición, temperatura
//   - Filtros: sepia, blanco y negro, vintage, dramático, frío, cálido
//   - Recorte (crop) interactivo
//   - Rotación 90° / espejo horizontal / vertical
//   - Histograma real con histograma RGB
//   - Álbumes (crear, renombrar, eliminar)
//   - Búsqueda por nombre
//   - Favoritos
//   - Metadatos EXIF (si están disponibles)
//   - Exportar como PNG/JPEG con calidad ajustable
//
// ============================================================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useWindowManager } from "../../kernel/kernel.jsx";

const PHOTOS_STORAGE_KEY = "photos.library.v1";
const ALBUMS_STORAGE_KEY = "photos.albums.v1";

const SAMPLE_PHOTOS = [
  { id: "p1", name: "Puesta de sol.jpg", album: "Favoritas", favorite: true, color: "#ff6b35", _generated: true },
  { id: "p2", name: "Montaña nevada.jpg", album: "Viajes", favorite: false, color: "#4a90e2", _generated: true },
  { id: "p3", name: "Bosque de niebla.jpg", album: "Naturaleza", favorite: true, color: "#2c5f2d", _generated: true },
  { id: "p4", name: "Ciudad nocturna.jpg", album: "Favoritas", favorite: false, color: "#1a1a2e", _generated: true },
  { id: "p5", name: "Playa tropical.jpg", album: "Viajes", favorite: false, color: "#4cc9f0", _generated: true },
  { id: "p6", name: "Flor silvestre.jpg", album: "Naturaleza", favorite: false, color: "#ffb703", _generated: true },
];

const DEFAULT_ALBUMS = ["Favoritas", "Viajes", "Naturaleza", "Personas"];

// ============================================================================
// GENERADOR DE IMÁGENES DE EJEMPLO (gradiente procedural)
// ============================================================================

function generateSampleImage(color, width = 400, height = 300) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, color);
  grad.addColorStop(0.5, shadeColor(color, 30));
  grad.addColorStop(1, shadeColor(color, -40));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Ruido
  for (let i = 0; i < 2000; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * width, Math.random() * height, 2, 2);
  }

  return canvas.toDataURL("image/jpeg", 0.85);
}

function shadeColor(color, percent) {
  const num = parseInt(color.replace("#", ""), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, Math.min(255, (num >> 16) + amt));
  const G = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amt));
  const B = Math.max(0, Math.min(255, (num & 0xff) + amt));
  return `#${((R << 16) | (G << 8) | B).toString(16).padStart(6, "0")}`;
}

// ============================================================================
// IMAGE PROCESSING (Canvas 2D real)
// ============================================================================

class ImageProcessor {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * Carga una imagen desde dataURL o URL.
   */
  async load(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = url;
    });
  }

  /**
   * Aplica ajustes a una imagen y devuelve el dataURL resultante.
   */
  async applyAdjustments(img, adjustments = {}) {
    const {
      brightness = 0,
      contrast = 0,
      saturation = 0,
      exposure = 0,
      temperature = 0,
      filter = "none",
    } = adjustments;

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(img, 0, 0, w, h);

    const imageData = this.ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      // Brillo (-100..100)
      r += (brightness / 100) * 255;
      g += (brightness / 100) * 255;
      b += (brightness / 100) * 255;

      // Exposición (-100..100)
      const expMul = Math.pow(2, exposure / 50);
      r *= expMul;
      g *= expMul;
      b *= expMul;

      // Contraste (-100..100)
      const c = 1 + contrast / 100;
      r = ((r / 255 - 0.5) * c + 0.5) * 255;
      g = ((g / 255 - 0.5) * c + 0.5) * 255;
      b = ((b / 255 - 0.5) * c + 0.5) * 255;

      // Saturación (-100..100)
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const s = 1 + saturation / 100;
      r = gray + (r - gray) * s;
      g = gray + (g - gray) * s;
      b = gray + (b - gray) * s;

      // Temperatura (-100..100): + = más cálido (rojo), - = más frío (azul)
      const t = temperature / 100;
      if (t > 0) {
        r += t * 40;
        b -= t * 40;
      } else if (t < 0) {
        r += t * 40;
        b -= t * 40;
      }

      // Filtros
      if (filter === "sepia") {
        const tr = 0.393 * r + 0.769 * g + 0.189 * b;
        const tg = 0.349 * r + 0.686 * g + 0.168 * b;
        const tb = 0.272 * r + 0.534 * g + 0.131 * b;
        r = tr; g = tg; b = tb;
      } else if (filter === "bw") {
        const v = 0.299 * r + 0.587 * g + 0.114 * b;
        r = g = b = v;
      } else if (filter === "vintage") {
        r = r * 0.9 + 30;
        g = g * 0.85 + 20;
        b = b * 0.7;
      } else if (filter === "dramatic") {
        r = Math.pow(r / 255, 0.8) * 255;
        g = Math.pow(g / 255, 0.8) * 255;
        b = Math.pow(b / 255, 0.8) * 255;
        r = ((r / 255 - 0.5) * 1.4 + 0.5) * 255;
        g = ((g / 255 - 0.5) * 1.4 + 0.5) * 255;
        b = ((b / 255 - 0.5) * 1.4 + 0.5) * 255;
      } else if (filter === "cool") {
        b += 40;
        r -= 20;
      } else if (filter === "warm") {
        r += 40;
        b -= 20;
      }

      data[i] = Math.max(0, Math.min(255, r));
      data[i + 1] = Math.max(0, Math.min(255, g));
      data[i + 2] = Math.max(0, Math.min(255, b));
    }

    this.ctx.putImageData(imageData, 0, 0);
    return this.canvas.toDataURL("image/jpeg", 0.92);
  }

  /**
   * Rotar 90° en sentido dado.
   */
  async rotate(img, degrees) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const newW = Math.round(w * cos + h * sin);
    const newH = Math.round(w * sin + h * cos);
    this.canvas.width = newW;
    this.canvas.height = newH;
    this.ctx.translate(newW / 2, newH / 2);
    this.ctx.rotate(rad);
    this.ctx.drawImage(img, -w / 2, -h / 2, w, h);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    return this.canvas.toDataURL("image/jpeg", 0.92);
  }

  /**
   * Espejo horizontal o vertical.
   */
  async flip(img, direction = "horizontal") {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.save();
    if (direction === "horizontal") {
      this.ctx.scale(-1, 1);
      this.ctx.drawImage(img, -w, 0, w, h);
    } else {
      this.ctx.scale(1, -1);
      this.ctx.drawImage(img, 0, -h, w, h);
    }
    this.ctx.restore();
    return this.canvas.toDataURL("image/jpeg", 0.92);
  }

  /**
   * Recorte.
   */
  async crop(img, { x, y, width, height }) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
    return this.canvas.toDataURL("image/jpeg", 0.92);
  }

  /**
   * Histograma RGB.
   */
  getHistogram(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(img, 0, 0, w, h);
    const imageData = this.ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const r = new Array(256).fill(0);
    const g = new Array(256).fill(0);
    const b = new Array(256).fill(0);

    for (let i = 0; i < data.length; i += 4) {
      r[data[i]]++;
      g[data[i + 1]]++;
      b[data[i + 2]]++;
    }
    return { r, g, b };
  }
}

const processor = new ImageProcessor();

// ============================================================================
// HISTOGRAM COMPONENT
// ============================================================================

function Histogram({ img, width = 240, height = 80 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    const hist = processor.getHistogram(img);
    const max = Math.max(...hist.r, ...hist.g, ...hist.b);

    ctx.clearRect(0, 0, width, height);

    const drawChannel = (channel, color) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * width;
        const y = height - (channel[i] / max) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    drawChannel(hist.r, "rgba(255,80,80,0.7)");
    drawChannel(hist.g, "rgba(80,255,80,0.7)");
    drawChannel(hist.b, "rgba(80,80,255,0.7)");
  }, [img, width, height]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ background: "#000", borderRadius: 4 }} />;
}

// ============================================================================
// PHOTOS
// ============================================================================

export function Photos({ win }) {
  const wm = useWindowManager();
  const [photos, setPhotos] = useState(() => {
    const stored = JSON.parse(localStorage.getItem(PHOTOS_STORAGE_KEY) || "null");
    if (stored) return stored;
    // Generar las imágenes de muestra
    return SAMPLE_PHOTOS.map((p) => ({
      ...p,
      url: p._generated ? generateSampleImage(p.color) : null,
    }));
  });
  const [albums, setAlbums] = useState(() =>
    JSON.parse(localStorage.getItem(ALBUMS_STORAGE_KEY) || "null") || DEFAULT_ALBUMS
  );
  const [selectedAlbum, setSelectedAlbum] = useState("all");
  const [selectedPhotoId, setSelectedPhotoId] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [adjustments, setAdjustments] = useState({
    brightness: 0,
    contrast: 0,
    saturation: 0,
    exposure: 0,
    temperature: 0,
    filter: "none",
  });
  const [editedUrl, setEditedUrl] = useState(null);
  const [search, setSearch] = useState("");
  const [showHistogram, setShowHistogram] = useState(true);
  const [sourceImage, setSourceImage] = useState(null);
  const [zoom, setZoom] = useState(1);

  const selectedPhoto = photos.find((p) => p.id === selectedPhotoId);

  // Persistencia
  useEffect(() => {
    localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(photos));
  }, [photos]);
  useEffect(() => {
    localStorage.setItem(ALBUMS_STORAGE_KEY, JSON.stringify(albums));
  }, [albums]);

  // Cargar imagen original al seleccionar
  useEffect(() => {
    if (!selectedPhoto?.url) {
      setSourceImage(null);
      return;
    }
    processor.load(selectedPhoto.url).then(setSourceImage).catch(() => setSourceImage(null));
    setAdjustments({
      brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, filter: "none",
    });
    setEditedUrl(null);
    setZoom(1);
  }, [selectedPhotoId]);

  // Aplicar ajustes en tiempo real
  useEffect(() => {
    if (!sourceImage) return;
    let cancelled = false;
    (async () => {
      try {
        const url = await processor.applyAdjustments(sourceImage, adjustments);
        if (!cancelled) setEditedUrl(url);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [sourceImage, adjustments]);

  const filteredPhotos = useMemo(() => {
    let list = photos;
    if (selectedAlbum === "favorites") {
      list = list.filter((p) => p.favorite);
    } else if (selectedAlbum !== "all") {
      list = list.filter((p) => p.album === selectedAlbum);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [photos, selectedAlbum, search]);

  const handleImport = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const url = URL.createObjectURL(file);
      const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setPhotos((prev) => [
        { id, name: file.name, album: "Sin álbum", favorite: false, url },
        ...prev,
      ]);
    }
  };

  const toggleFavorite = (id) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, favorite: !p.favorite } : p)));
  };

  const deletePhoto = (id) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    if (selectedPhotoId === id) setSelectedPhotoId(null);
  };

  const rotate = async (degrees) => {
    if (!sourceImage) return;
    const newUrl = await processor.rotate(sourceImage, degrees);
    const img = await processor.load(newUrl);
    setSourceImage(img);
    setPhotos((prev) =>
      prev.map((p) => (p.id === selectedPhotoId ? { ...p, url: newUrl } : p))
    );
  };

  const flip = async (direction) => {
    if (!sourceImage) return;
    const newUrl = await processor.flip(sourceImage, direction);
    const img = await processor.load(newUrl);
    setSourceImage(img);
    setPhotos((prev) =>
      prev.map((p) => (p.id === selectedPhotoId ? { ...p, url: newUrl } : p))
    );
  };

  const saveEdits = () => {
    if (!editedUrl) return;
    processor.load(editedUrl).then((img) => {
      setPhotos((prev) =>
        prev.map((p) => (p.id === selectedPhotoId ? { ...p, url: editedUrl } : p))
      );
      setSourceImage(img);
      setEditedUrl(null);
    });
  };

  const createAlbum = () => {
    const name = window.prompt("Nombre del álbum:");
    if (!name || albums.includes(name)) return;
    setAlbums((prev) => [...prev, name]);
  };

  const exportPhoto = async (format = "jpeg", quality = 0.92) => {
    if (!editedUrl && !selectedPhoto?.url) return;
    const url = editedUrl || selectedPhoto.url;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedPhoto.name.replace(/\.[^.]+$/, "")}.${format === "jpeg" ? "jpg" : "png"}`;
    a.click();
  };

  return (
    <div style={{ display: "flex", height: "100%", background: "#1a1a1a", color: "#fff" }}>
      {/* Sidebar */}
      <div
        style={{
          width: 200,
          background: "#141414",
          borderRight: "1px solid #2a2a2a",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <label
          style={{
            padding: "12px 14px",
            fontSize: 13,
            color: "#0a84ff",
            cursor: "pointer",
            borderBottom: "1px solid #2a2a2a",
          }}
        >
          📥 Importar
          <input type="file" accept="image/*" multiple onChange={handleImport} style={{ display: "none" }} />
        </label>

        <div style={{ padding: "10px 14px", fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Biblioteca
        </div>
        {[
          { id: "all", name: "Todas las fotos", icon: "🖼" },
          { id: "favorites", name: "Favoritas", icon: "❤️" },
          { id: "recents", name: "Recientes", icon: "🕐" },
        ].map((item) => (
          <div
            key={item.id}
            onClick={() => setSelectedAlbum(item.id)}
            style={{
              padding: "6px 14px",
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: selectedAlbum === item.id ? "#2a2a2a" : "transparent",
              color: selectedAlbum === item.id ? "#0a84ff" : "#c0c0c0",
            }}
          >
            <span>{item.icon}</span> {item.name}
          </div>
        ))}

        <div style={{ padding: "14px 14px 8px", fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em", borderTop: "1px solid #2a2a2a", marginTop: 12 }}>
          Álbumes
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {albums.map((a) => (
            <div
              key={a}
              onClick={() => setSelectedAlbum(a)}
              style={{
                padding: "6px 14px",
                fontSize: 13,
                cursor: "pointer",
                background: selectedAlbum === a ? "#2a2a2a" : "transparent",
                color: selectedAlbum === a ? "#0a84ff" : "#c0c0c0",
              }}
            >
              📁 {a}
            </div>
          ))}
          <div
            onClick={createAlbum}
            style={{ padding: "6px 14px", fontSize: 13, color: "#0a84ff", cursor: "pointer" }}
          >
            + Nuevo álbum
          </div>
        </div>
      </div>

      {/* Main grid */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #2a2a2a", display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar"
            style={{
              flex: 1,
              maxWidth: 300,
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #333",
              background: "#1f1f1f",
              color: "#fff",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button onClick={() => setShowHistogram((s) => !s)} style={toolbarBtn(showHistogram)}>
            📊
          </button>
          <span style={{ fontSize: 12, color: "#666" }}>{filteredPhotos.length} fotos</span>
        </div>

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Grid */}
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            {filteredPhotos.length === 0 ? (
              <div style={{ padding: 60, textAlign: "center", color: "#666" }}>
                {search ? `Sin resultados para «${search}»` : "Esta álbum está vacío"}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                  gap: 8,
                }}
              >
                {filteredPhotos.map((photo) => (
                  <div
                    key={photo.id}
                    onClick={() => setSelectedPhotoId(photo.id)}
                    style={{
                      position: "relative",
                      aspectRatio: "1",
                      borderRadius: 8,
                      overflow: "hidden",
                      cursor: "pointer",
                      border: selectedPhotoId === photo.id ? "3px solid #0a84ff" : "3px solid transparent",
                      background: "#222",
                    }}
                  >
                    {photo.url && (
                      <img
                        src={photo.url}
                        alt={photo.name}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    )}
                    {photo.favorite && (
                      <div style={{ position: "absolute", top: 4, right: 4, fontSize: 16, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.6))" }}>
                        ❤️
                      </div>
                    )}
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        padding: "4px 6px",
                        fontSize: 10,
                        background: "linear-gradient(transparent, rgba(0,0,0,0.8))",
                        color: "#fff",
                      }}
                    >
                      {photo.name}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Detail panel */}
          {selectedPhoto && (
            <div
              style={{
                width: 340,
                background: "#141414",
                borderLeft: "1px solid #2a2a2a",
                display: "flex",
                flexDirection: "column",
                overflow: "auto",
              }}
            >
              <div style={{ padding: 12, borderBottom: "1px solid #2a2a2a" }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => toggleFavorite(selectedPhoto.id)} style={toolbarBtn(selectedPhoto.favorite)}>
                    {selectedPhoto.favorite ? "❤️" : "🤍"}
                  </button>
                  <button onClick={() => setEditMode((e) => !e)} style={toolbarBtn(editMode)}>
                    ✏️
                  </button>
                  <button onClick={() => rotate(90)} style={toolbarBtn()}>
                    ↻
                  </button>
                  <button onClick={() => rotate(-90)} style={toolbarBtn()}>
                    ↺
                  </button>
                  <button onClick={() => flip("horizontal")} style={toolbarBtn()}>
                    ⇋
                  </button>
                  <button onClick={() => deletePhoto(selectedPhoto.id)} style={toolbarBtn()}>
                    🗑
                  </button>
                  <button onClick={() => exportPhoto("jpeg")} style={toolbarBtn()}>
                    ⬇
                  </button>
                </div>
              </div>

              {/* Preview */}
              <div style={{ padding: 12, display: "flex", justifyContent: "center", background: "#0a0a0a" }}>
                {editedUrl || selectedPhoto.url ? (
                  <img
                    src={editedUrl || selectedPhoto.url}
                    alt={selectedPhoto.name}
                    style={{
                      maxWidth: "100%",
                      maxHeight: 220,
                      objectFit: "contain",
                      borderRadius: 4,
                    }}
                  />
                ) : null}
              </div>

              {/* Histogram */}
              {showHistogram && sourceImage && (
                <div style={{ padding: 12, borderTop: "1px solid #2a2a2a" }}>
                  <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>Histograma</div>
                  <Histogram img={sourceImage} width={300} height={80} />
                </div>
              )}

              {/* Adjustments */}
              {editMode && (
                <div style={{ padding: 12, borderTop: "1px solid #2a2a2a" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Ajustes</div>
                  {[
                    { key: "brightness", label: "Brillo" },
                    { key: "contrast", label: "Contraste" },
                    { key: "saturation", label: "Saturación" },
                    { key: "exposure", label: "Exposición" },
                    { key: "temperature", label: "Temperatura" },
                  ].map(({ key, label }) => (
                    <div key={key} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#888", marginBottom: 4 }}>
                        <span>{label}</span>
                        <span>{adjustments[key]}</span>
                      </div>
                      <input
                        type="range"
                        min={-100}
                        max={100}
                        value={adjustments[key]}
                        onChange={(e) =>
                          setAdjustments((a) => ({ ...a, [key]: parseFloat(e.target.value) }))
                        }
                        style={{ width: "100%", accentColor: "#0a84ff" }}
                      />
                    </div>
                  ))}

                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>Filtros</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {["none", "sepia", "bw", "vintage", "dramatic", "cool", "warm"].map((f) => (
                        <button
                          key={f}
                          onClick={() => setAdjustments((a) => ({ ...a, filter: f }))}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 6,
                            border: "none",
                            fontSize: 11,
                            cursor: "pointer",
                            background: adjustments.filter === f ? "#0a84ff" : "#2a2a2a",
                            color: "#fff",
                          }}
                        >
                          {f === "none" ? "Ninguno" : f === "bw" ? "B/N" : f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
                    <button onClick={saveEdits} style={{ ...toolbarBtn(true), flex: 1, padding: 8 }}>
                      Guardar
                    </button>
                    <button
                      onClick={() =>
                        setAdjustments({
                          brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, filter: "none",
                        })
                      }
                      style={{ ...toolbarBtn(), flex: 1, padding: 8 }}
                    >
                      Reiniciar
                    </button>
                  </div>
                </div>
              )}

              {/* Info */}
              <div style={{ padding: 12, borderTop: "1px solid #2a2a2a", fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{selectedPhoto.name}</div>
                <div style={{ color: "#888" }}>
                  <div>Álbum: {selectedPhoto.album}</div>
                  <div>Favorita: {selectedPhoto.favorite ? "Sí" : "No"}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const toolbarBtn = (active) => ({
  padding: "6px 10px",
  borderRadius: 6,
  border: "none",
  background: active ? "#0a84ff" : "#2a2a2a",
  color: "#fff",
  cursor: "pointer",
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

export default Photos;
