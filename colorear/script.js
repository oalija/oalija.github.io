// Elementos del DOM
const imageUpload = document.getElementById('imageUpload');
const uploadSpan = document.querySelector('.upload-btn span');
const processBtn = document.getElementById('processBtn');
const paletteContainer = document.getElementById('paletteContainer');
const paletteEl = document.getElementById('palette');
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const loadingEl = document.getElementById('loading');
const restartBtn = document.getElementById('restartBtn');
const tooltip = document.createElement('div');
tooltip.id = 'tooltip';
tooltip.className = 'hidden';
document.body.appendChild(tooltip);

// Variables globales de estado
let originalImage = null;
let imageWidth = 0;
let imageHeight = 0;

let colorIndices = null;
let centroids = [];
let regions = [];
let regionMap = null;

let baseImageData = null;
let currentImageData = null;
let originalImageData = null;

let selectedColorIndex = -1;
let completedRegions = 0;
let labelMap = {};

// Constantes
const MAX_DIMENSION = 800; // Escalamos la imagen si es muy grande para no bloquear el navegador
const MIN_REGION_PIXELS = 30; // Reducido para permitir más detalle, pero limpiar las inclickables
const MERGE_THRESHOLD_PIXELS = 150; // Las zonas menores se absorben para limpiar

// --- 1. Manejo de subida de imagen ---
imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        uploadSpan.textContent = file.name;
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                originalImage = img;
                processBtn.disabled = false;
                setupCanvas(img);
                paletteContainer.classList.add('hidden');
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    }
});

function setupCanvas(img) {
    let w = img.width;
    let h = img.height;

    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
        const ratio = Math.min(MAX_DIMENSION / w, MAX_DIMENSION / h);
        w = Math.floor(w * ratio);
        h = Math.floor(h * ratio);
    }

    canvas.width = w;
    canvas.height = h;
    imageWidth = w;
    imageHeight = h;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
}

// --- 2. Procesamiento (K-Means + Segmentación) ---
processBtn.addEventListener('click', () => {
    if (!originalImage) return;

    const k = parseInt(document.querySelector('input[name="colorMode"]:checked').value);

    document.body.classList.replace('state-initial', 'state-painting');
    loadingEl.classList.remove('hidden');
    processBtn.disabled = true;

    // Usamos setTimeout para permitir que el DOM renderice el loading
    setTimeout(() => {
        try {
            processImage(k);
            restartBtn.classList.remove('hidden');
        } catch (e) {
            console.error(e);
            showFlash("Error al procesar la imagen. Intenta con una más pequeña.");
            document.body.classList.replace('state-painting', 'state-initial');
        } finally {
            loadingEl.classList.add('hidden');
            processBtn.disabled = false;
        }
    }, 50);
});

restartBtn.addEventListener('click', () => {
    document.body.classList.replace('state-painting', 'state-initial');
    originalImage = null;
    uploadSpan.textContent = "SELECCIONAR FOTO";
    processBtn.disabled = true;
    imageUpload.value = '';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paletteContainer.classList.add('hidden');
    restartBtn.classList.add('hidden');
});

function processImage(k) {
    // 1. Obtener píxeles originales
    setupCanvas(originalImage); // redibujar limpio al tamaño correcto
    originalImageData = ctx.getImageData(0, 0, imageWidth, imageHeight); // Guardamos la nítida para pintar luego

    // Eliminamos el desenfoque previo porque creaba anillos en bordes definidos.
    // Usaremos un filtro modal más fuerte post-procesado.
    const imageData = ctx.getImageData(0, 0, imageWidth, imageHeight);

    // 2. K-Means (k es el máximo inicial)
    let initialCentroids = kMeans(imageData, k);

    // 2.5 Fusionar colores similares (distancia al cuadrado < 1600 ~ 40 unidades por canal RGB)
    centroids = mergeSimilarColors(initialCentroids, 1600);
    const actualK = centroids.length;

    // 3. Mapear la imagen a los colores representativos resultantes
    colorIndices = new Uint8Array(imageWidth * imageHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        let minDist = Infinity;
        let minIdx = 0;
        for (let j = 0; j < actualK; j++) {
            const c = centroids[j];
            const dist = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
            if (dist < minDist) {
                minDist = dist;
                minIdx = j;
            }
        }
        colorIndices[i / 4] = minIdx;
    }

    // 3.5 Suavizar bordes ("desdentado")
    smoothBorders(5, 2); // 5 pasadas con un radio de 2 (ventana de 5x5)

    // 4. Extraer Regiones (Flood Fill) inicial
    extractRegions();

    // 4.5. Absorber zonas inclickables
    removeSmallRegions(MERGE_THRESHOLD_PIXELS);

    // 5. Preparar la imagen base (Grises + Bordes)
    prepareBaseImage();

    // 6. Preparar UI
    buildPalette();
    currentImageData = new ImageData(
        new Uint8ClampedArray(baseImageData.data),
        imageWidth,
        imageHeight
    );
    drawCanvas();
    showFlash("¡Lienzo listo! Selecciona un color de la paleta.", "success");
}

function kMeans(imageData, k) {
    const data = imageData.data;
    const pixels = [];
    // Submuestreo para K-Means rápido (max ~10000 píxeles)
    const step = Math.max(4, Math.floor(data.length / 4 / 10000) * 4);

    for (let i = 0; i < data.length; i += step) {
        pixels.push([data[i], data[i + 1], data[i + 2]]);
    }

    // Inicialización aleatoria de centroides
    let centroids = [];
    for (let i = 0; i < k; i++) {
        centroids.push(pixels[Math.floor(Math.random() * pixels.length)]);
    }

    // Iteraciones
    for (let iter = 0; iter < 10; iter++) {
        const sums = Array.from({ length: k }, () => [0, 0, 0]);
        const counts = new Int32Array(k);

        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            let minDist = Infinity;
            let minIdx = 0;
            for (let j = 0; j < k; j++) {
                const c = centroids[j];
                const dist = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
                if (dist < minDist) {
                    minDist = dist;
                    minIdx = j;
                }
            }
            sums[minIdx][0] += p[0];
            sums[minIdx][1] += p[1];
            sums[minIdx][2] += p[2];
            counts[minIdx]++;
        }

        let changed = false;
        for (let j = 0; j < k; j++) {
            if (counts[j] > 0) {
                const newR = sums[j][0] / counts[j];
                const newG = sums[j][1] / counts[j];
                const newB = sums[j][2] / counts[j];
                if (Math.abs(centroids[j][0] - newR) > 1 ||
                    Math.abs(centroids[j][1] - newG) > 1 ||
                    Math.abs(centroids[j][2] - newB) > 1) {
                    changed = true;
                }
                centroids[j] = [newR, newG, newB];
            }
        }
        if (!changed) break;
    }
    return centroids.map(c => c.map(Math.round));
}

function mergeSimilarColors(colors, thresholdSq) {
    let merged = [...colors];
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < merged.length; i++) {
            for (let j = i + 1; j < merged.length; j++) {
                const c1 = merged[i];
                const c2 = merged[j];
                const distSq = (c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2;
                if (distSq < thresholdSq) {
                    // Promediar y eliminar el repetido
                    merged[i] = [
                        Math.round((c1[0] + c2[0]) / 2),
                        Math.round((c1[1] + c2[1]) / 2),
                        Math.round((c1[2] + c2[2]) / 2)
                    ];
                    merged.splice(j, 1);
                    changed = true;
                    break;
                }
            }
            if (changed) break;
        }
    }
    return merged;
}

function smoothBorders(passes, radius = 1) {
    for (let p = 0; p < passes; p++) {
        const newIndices = new Uint8Array(colorIndices.length);
        for (let y = 0; y < imageHeight; y++) {
            for (let x = 0; x < imageWidth; x++) {
                const counts = new Int32Array(centroids.length);
                let maxC = 0;
                let bestColor = colorIndices[y * imageWidth + x];
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const ny = y + dy;
                        const nx = x + dx;
                        if (ny >= 0 && ny < imageHeight && nx >= 0 && nx < imageWidth) {
                            const c = colorIndices[ny * imageWidth + nx];
                            counts[c]++;
                            if (counts[c] > maxC) {
                                maxC = counts[c];
                                bestColor = c;
                            }
                        }
                    }
                }
                newIndices[y * imageWidth + x] = bestColor;
            }
        }
        colorIndices = newIndices;
    }
}

function removeSmallRegions(minSize) {
    let changed = true;
    let maxPasses = 10;
    while (changed && maxPasses > 0) {
        changed = false;
        maxPasses--;

        for (let i = 0; i < regions.length; i++) {
            const r = regions[i];
            if (r.pixels.length > 0 && r.pixels.length < minSize) {
                let neighborColors = new Int32Array(centroids.length);
                for (let j = 0; j < r.pixels.length; j++) {
                    const p = r.pixels[j];
                    const cx = p % imageWidth;
                    const cy = Math.floor(p / imageWidth);

                    const check = (idx) => {
                        const nId = regionMap[idx];
                        if (nId !== r.id && nId !== -1) {
                            const nc = regions[nId].colorIndex;
                            neighborColors[nc]++;
                        }
                    };

                    if (cx > 0) check(p - 1);
                    if (cx < imageWidth - 1) check(p + 1);
                    if (cy > 0) check(p - imageWidth);
                    if (cy < imageHeight - 1) check(p + imageWidth);
                }

                let bestC = -1;
                let maxN = -1;
                for (let c = 0; c < centroids.length; c++) {
                    if (neighborColors[c] > maxN) {
                        maxN = neighborColors[c];
                        bestC = c;
                    }
                }

                if (bestC !== -1 && bestC !== r.colorIndex) {
                    for (let j = 0; j < r.pixels.length; j++) {
                        colorIndices[r.pixels[j]] = bestC;
                    }
                    changed = true;
                }
            }
        }

        if (changed) {
            extractRegions();
        }
    }
}

function extractRegions() {
    regions = [];
    regionMap = new Int32Array(imageWidth * imageHeight).fill(-1);

    let regionId = 0;
    for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
            const idx = y * imageWidth + x;
            if (regionMap[idx] === -1) {
                const cIdx = colorIndices[idx];
                const region = {
                    id: regionId,
                    colorIndex: cIdx,
                    pixels: [],
                    filled: false,
                    centerX: 0,
                    centerY: 0
                };

                // Breadth First Search (Flood Fill)
                const q = [idx];
                regionMap[idx] = regionId;
                let head = 0;

                let sumX = 0, sumY = 0;

                while (head < q.length) {
                    const cur = q[head++];
                    region.pixels.push(cur);

                    const cy = Math.floor(cur / imageWidth);
                    const cx = cur % imageWidth;

                    sumX += cx;
                    sumY += cy;

                    // Vecinos (arriba, abajo, izq, der)
                    if (cx > 0) {
                        let ni = cur - 1;
                        if (regionMap[ni] === -1 && colorIndices[ni] === cIdx) {
                            regionMap[ni] = regionId; q.push(ni);
                        }
                    }
                    if (cx < imageWidth - 1) {
                        let ni = cur + 1;
                        if (regionMap[ni] === -1 && colorIndices[ni] === cIdx) {
                            regionMap[ni] = regionId; q.push(ni);
                        }
                    }
                    if (cy > 0) {
                        let ni = cur - imageWidth;
                        if (regionMap[ni] === -1 && colorIndices[ni] === cIdx) {
                            regionMap[ni] = regionId; q.push(ni);
                        }
                    }
                    if (cy < imageHeight - 1) {
                        let ni = cur + imageWidth;
                        if (regionMap[ni] === -1 && colorIndices[ni] === cIdx) {
                            regionMap[ni] = regionId; q.push(ni);
                        }
                    }
                }

                region.centerX = Math.floor(sumX / region.pixels.length);
                region.centerY = Math.floor(sumY / region.pixels.length);

                // Si el centro de masa cae fuera de la región o en un hueco, acercarlo a un píxel válido
                const centerIdx = region.centerY * imageWidth + region.centerX;
                if (regionMap[centerIdx] !== regionId) {
                    let bestP = region.pixels[0];
                    let minDist = Infinity;
                    for (const pi of region.pixels) {
                        const px = pi % imageWidth;
                        const py = Math.floor(pi / imageWidth);
                        const d = (px - region.centerX) ** 2 + (py - region.centerY) ** 2;
                        if (d < minDist) {
                            minDist = d;
                            bestP = pi;
                        }
                    }
                    region.centerX = bestP % imageWidth;
                    region.centerY = Math.floor(bestP / imageWidth);
                }

                regions.push(region);
                regionId++;
            }
        }
    }
}

function prepareBaseImage() {
    baseImageData = new ImageData(imageWidth, imageHeight);
    const data = baseImageData.data;

    for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
            const idx = y * imageWidth + x;
            const cIdx = colorIndices[idx];
            const rId = regionMap[idx];
            const c = centroids[cIdx];

            let isBoundary = false;
            if (x < imageWidth - 1 && regionMap[idx + 1] !== rId) isBoundary = true;
            if (y < imageHeight - 1 && regionMap[idx + imageWidth] !== rId) isBoundary = true;

            const outIdx = idx * 4;
            if (isBoundary) {
                // Borde suave oscuro
                data[outIdx] = 100;
                data[outIdx + 1] = 110;
                data[outIdx + 2] = 120;
                data[outIdx + 3] = 255;
            } else {
                // Escala de grises blanqueada para ver fácilmente los números
                let gray = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
                gray = 230 + (gray / 255) * 25; // Muy claro
                data[outIdx] = Math.min(255, gray);
                data[outIdx + 1] = Math.min(255, gray);
                data[outIdx + 2] = Math.min(255, gray);
                data[outIdx + 3] = 255;
            }
        }
    }
}

// --- 3. Renderizado y UI ---
function buildPalette() {
    paletteContainer.classList.remove('hidden');
    paletteEl.innerHTML = '';
    selectedColorIndex = -1;
    completedRegions = 0;
    labelMap = {};

    const usedColors = new Set();
    for (const r of regions) {
        if (r.pixels.length >= MIN_REGION_PIXELS) {
            usedColors.add(r.colorIndex);
        }
    }

    let displayIndex = 1;
    centroids.forEach((color, index) => {
        if (!usedColors.has(index)) return;

        labelMap[index] = displayIndex++;

        const swatch = document.createElement('div');
        swatch.className = 'color-swatch';
        swatch.style.backgroundColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

        // Contraste de texto en el swatch
        const lum = (0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]);
        swatch.style.color = lum > 150 ? '#0f111a' : '#ffffff';
        swatch.style.textShadow = lum > 150 ? 'none' : '0 1px 3px rgba(0,0,0,0.8)';

        swatch.textContent = labelMap[index];

        swatch.addEventListener('click', () => {
            if (swatch.classList.contains('completed')) return;
            document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('active'));
            swatch.classList.add('active');
            selectedColorIndex = index;
        });

        swatch.dataset.index = index;
        paletteEl.appendChild(swatch);
    });
}

function updatePaletteStatus() {
    // Revisar si algún color ya fue completamente pintado
    centroids.forEach((_, cIdx) => {
        if (labelMap[cIdx] === undefined) return;

        const remaining = regions.filter(r => r.colorIndex === cIdx && !r.filled && r.pixels.length >= MIN_REGION_PIXELS);
        if (remaining.length === 0) {
            const swatch = paletteEl.querySelector(`.color-swatch[data-index="${cIdx}"]`);
            if (swatch) {
                swatch.classList.add('completed');
                swatch.classList.remove('active');
                if (selectedColorIndex === cIdx) selectedColorIndex = -1;
            }
        }
    });

    // Verificar victoria
    const totalRemaining = regions.filter(r => !r.filled && r.pixels.length >= MIN_REGION_PIXELS).length;
    if (totalRemaining === 0) {
        showFlash("¡🎨 Obra Maestra Completada!", "success");
    }
}

function drawCanvas() {
    ctx.putImageData(currentImageData, 0, 0);

    // Dibujar textos
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const r of regions) {
        if (!r.filled && r.pixels.length >= MIN_REGION_PIXELS) {
            // Escalar fuente según tamaño de región
            let fontSize = 10;
            if (r.pixels.length > 1000) fontSize = 20;
            else if (r.pixels.length > 400) fontSize = 15;
            else if (r.pixels.length > 100) fontSize = 12;

            ctx.font = `600 ${fontSize}px 'Outfit', sans-serif`;

            // Halo blanco muy sutil para asegurar lectura
            ctx.lineWidth = 2.5;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            const labelText = labelMap[r.colorIndex] !== undefined ? labelMap[r.colorIndex] : "?";
            ctx.strokeText(labelText, r.centerX, r.centerY);

            ctx.fillStyle = '#1e293b';
            ctx.fillText(labelText, r.centerX, r.centerY);
        }
    }
}

// --- 4. Interacción ---
canvas.addEventListener('click', (e) => {
    if (selectedColorIndex === -1 || !currentImageData) {
        if (!currentImageData) return;
        showFlash("¡Selecciona un color de la paleta primero!");
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);

    if (x < 0 || x >= imageWidth || y < 0 || y >= imageHeight) return;

    const idx = y * imageWidth + x;
    const rId = regionMap[idx];

    if (rId !== -1) {
        const r = regions[rId];
        if (r.filled) return; // Ya pintada

        if (r.colorIndex === selectedColorIndex) {
            // ¡Pintar zona correcta mostrando los píxeles originales de la foto!
            r.filled = true;
            const data = currentImageData.data;
            const origData = originalImageData.data;
            for (const p of r.pixels) {
                const outIdx = p * 4;
                data[outIdx] = origData[outIdx];
                data[outIdx + 1] = origData[outIdx + 1];
                data[outIdx + 2] = origData[outIdx + 2];
                data[outIdx + 3] = 255;
            }
            // También rellenamos regiones MUY pequeñas adyacentes del mismo color para evitar pixeles sueltos molestos
            const verySmall = regions.filter(sr => !sr.filled && sr.colorIndex === r.colorIndex && sr.pixels.length < MIN_REGION_PIXELS);
            for (const sr of verySmall) {
                // Heurística rápida: si hacemos click, las que no son clickeables se auto-rellenan eventualmente
                sr.filled = true;
                for (const p of sr.pixels) {
                    const outIdx = p * 4;
                    data[outIdx] = origData[outIdx];
                    data[outIdx + 1] = origData[outIdx + 1];
                    data[outIdx + 2] = origData[outIdx + 2];
                    data[outIdx + 3] = 255;
                }
            }

            drawCanvas();
            updatePaletteStatus();
        } else {
            // Color equivocado
            showFlash(`Oops! Esa zona lleva el color ${labelMap[r.colorIndex] !== undefined ? labelMap[r.colorIndex] : "?"}`);
        }
    }
});

canvas.addEventListener('mousemove', (e) => {
    if (!currentImageData || selectedColorIndex === -1) {
        canvas.style.cursor = 'default';
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);

    if (x < 0 || x >= imageWidth || y < 0 || y >= imageHeight) return;

    const idx = y * imageWidth + x;
    const rId = regionMap[idx];

    if (rId !== -1) {
        const r = regions[rId];
        if (!r.filled && r.colorIndex === selectedColorIndex) {
            canvas.style.cursor = 'crosshair';
        } else if (!r.filled) {
            canvas.style.cursor = 'help';
        } else {
            canvas.style.cursor = 'default';
        }
    } else {
        canvas.style.cursor = 'default';
    }
});

let flashTimeout;
function showFlash(msg, type = 'error') {
    // Eliminar si hay uno previo
    const existing = document.querySelector('.flash-message');
    if (existing) existing.remove();
    if (flashTimeout) clearTimeout(flashTimeout);

    const flash = document.createElement('div');
    flash.className = `flash-message ${type}`;
    flash.textContent = msg;
    document.body.appendChild(flash);

    // Force reflow for transition
    void flash.offsetWidth;
    flash.classList.add('show');

    flashTimeout = setTimeout(() => {
        flash.classList.remove('show');
        setTimeout(() => flash.remove(), 400);
    }, 2500);
}
