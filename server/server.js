const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const archiver = require('archiver');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Increase the request size limit
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Make path available on client-side
app.use((req, res, next) => {
  // Add path module to res.locals so it can be used in client-side code
  res.locals.path = path;
  next();
});

// Configure debug logging
const DEBUG = true;
function debugLog(...args) {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

// Configurare storage pentru multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

// Configure multer for handling multiple files
const multiPageUpload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB file size limit
}).any();

// Configure multer for handling folder uploads
const folderStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      // Use query parameter first to reliably retrieve sessionId before multer parses body
      const sessionId = req.query.sessionId || req.body.sessionId || Date.now().toString();
      const uploadDir = path.join(__dirname, 'uploads', sessionId);
      debugLog(`Creating upload directory for session ${sessionId}: ${uploadDir}`);
      fs.ensureDirSync(uploadDir);
      cb(null, uploadDir);
    } catch (error) {
      console.error('Error creating upload directory:', error);
      // Fallback to the main uploads directory
      const uploadDir = path.join(__dirname, 'uploads');
      fs.ensureDirSync(uploadDir);
      cb(null, uploadDir);
    }
  },
  filename: (req, file, cb) => {
    // Use the original filename to preserve matching between image and box files
    // But replace problematic characters
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, safeName);
  }
});

const folderUpload = multer({
  storage: folderStorage,
  limits: { 
    fileSize: 100 * 1024 * 1024 // 100MB file size limit per file
  }
}).array('files');

// Ruta pentru upload imagine
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nu s-a încărcat nicio imagine' });
  }
  
  // Verificare dacă fișierul este TIFF
  const fileExtension = path.extname(req.file.originalname).toLowerCase();
  if (['.tif', '.tiff'].includes(fileExtension)) {
    // Procesăm fișierul TIFF
    try {
      // Creăm directorul pentru fișiere procesate
      const processedDir = path.join(__dirname, 'processed');
      fs.ensureDirSync(processedDir);
      
      // Convertim TIFF în PNG folosind sharp
      const outputBaseName = path.basename(req.file.filename, fileExtension);
      const outputPath = path.join(processedDir, `${outputBaseName}.png`);
      
      console.log(`Procesare TIFF: ${req.file.path} -> ${outputPath}`);
      
      // Folosim await pentru a ne asigura că procesarea se termină înainte de a trimite răspunsul
      await sharp(req.file.path)
        .png()
        .toFile(outputPath);
      
      console.log(`TIFF procesat cu succes: ${outputPath}`);
      
      // Adăugăm calea către fișierul procesat în răspuns
      return res.json({
        success: true,
        filePath: req.file.path,
        fileName: req.file.filename,
        processedName: `${outputBaseName}.png`,
        processedPath: outputPath,
        isProcessed: true
      });
    } catch (error) {
      console.error('Eroare la procesarea fișierului TIFF:', error);
      return res.status(500).json({ error: 'Eroare la procesarea fișierului TIFF: ' + error.message });
    }
  }
  
  res.json({
    success: true,
    filePath: req.file.path,
    fileName: req.file.filename
  });
});

// Ruta pentru a accesa imaginile TIFF procesate
app.get('/tiff-preview/:filename', (req, res) => {
  try {
    const processedDir = path.join(__dirname, 'processed');
    const filename = req.params.filename;
    
    console.log(`Se caută imaginea procesată: ${filename}`);
    console.log(`Director de căutare: ${processedDir}`);
    
    // Lista toate fișierele din directorul procesat pentru diagnostic
    if (fs.existsSync(processedDir)) {
      const files = fs.readdirSync(processedDir);
      console.log(`Fișiere disponibile în directorul procesat:`, files);
    }
    
    // Încercăm mai întâi exact numele fișierului
    let filePath = path.join(processedDir, filename);
    
    // Dacă nu există, încercăm să adăugăm extensia .png
    if (!fs.existsSync(filePath) && !filename.endsWith('.png')) {
      filePath = path.join(processedDir, `${filename}.png`);
    }
    
    // Dacă încă nu există, încercăm să eliminăm extensia și să adăugăm .png
    if (!fs.existsSync(filePath)) {
      const fileBasename = path.basename(filename, path.extname(filename));
      filePath = path.join(processedDir, `${fileBasename}.png`);
    }
    
    console.log(`Cale finală verificată: ${filePath}`);
    
    if (fs.existsSync(filePath)) {
      console.log(`Fișier găsit, se trimite: ${filePath}`);
      return res.sendFile(filePath);
    } else {
      console.log(`Fișierul nu a fost găsit: ${filePath}`);
      return res.status(404).json({ 
        error: 'Fișierul procesat nu a fost găsit',
        requestedFile: filename,
        searchedPaths: [
          path.join(processedDir, filename),
          path.join(processedDir, `${filename}.png`),
          filePath
        ]
      });
    }
  } catch (error) {
    console.error('Eroare la accesarea imaginii procesate:', error);
    res.status(500).json({ error: 'Eroare la accesarea imaginii procesate: ' + error.message });
  }
});

// Ruta pentru obținerea paginilor dintr-un TIFF multipagină
app.get('/api/tiff-pages/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Fișierul TIFF nu a fost găsit' });
    }
    
    const processedDir = path.join(__dirname, 'processed');
    fs.ensureDirSync(processedDir);
    
    // Utilizăm sharp pentru a determina numărul de pagini
    const metadata = await sharp(filePath).metadata();
    
    if (!metadata.pages || metadata.pages <= 1) {
      return res.json({ pages: [] });
    }
    
    // Procesăm fiecare pagină
    const pages = [];
    for (let i = 0; i < metadata.pages; i++) {
      const pageOutputPath = path.join(processedDir, `${path.basename(filename, path.extname(filename))}_page${i}.png`);
      
      await sharp(filePath, { page: i })
        .png()
        .toFile(pageOutputPath);
      
      pages.push(`/tiff-preview/${path.basename(pageOutputPath)}`);
    }
    
    res.json({ pages });
  } catch (error) {
    console.error('Eroare la procesarea paginilor TIFF:', error);
    res.status(500).json({ error: 'Eroare la procesarea paginilor TIFF' });
  }
});

// Ruta pentru croparea unei imagini
app.post('/api/crop-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nu s-a încărcat nicio imagine' });
    }
    
    const { x, y, width, height } = req.body;
    
    if (!x || !y || !width || !height) {
      return res.status(400).json({ error: 'Parametrii pentru crop sunt necesari: x, y, width, height' });
    }
    
    const outputDir = path.join(__dirname, 'cropped');
    fs.ensureDirSync(outputDir);
    
    const outputPath = path.join(outputDir, `cropped-${req.file.filename}`);
    
    await sharp(req.file.path)
      .extract({
        left: parseInt(x),
        top: parseInt(y),
        width: parseInt(width),
        height: parseInt(height)
      })
      .toFile(outputPath);
      
    res.json({
      success: true,
      croppedImagePath: outputPath
    });
  } catch (error) {
    console.error('Eroare la croparea imaginii:', error);
    res.status(500).json({ error: 'Eroare la procesarea imaginii' });
  }
});

// Ruta pentru generarea dataset-ului (single sau folder)
app.post('/api/generate-dataset', async (req, res) => {
  // Pentru a gestiona mulțiple imagini și formData, folosim multer.any()
  multiPageUpload(req, res, async (err) => {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({ error: 'Error processing uploads: ' + err.message });
    }
    try {
      console.log('----- Începerea generării dataset-ului -----');
      const datasetName = req.body.datasetName || 'dataset';
      const totalPages = parseInt(req.body.totalPages) || 1;
      
      console.log(`Generare dataset: ${datasetName}, pagini: ${totalPages}`);
      
      // Pregătim directoarele temporare
      const tempDir = path.join(__dirname, 'temp', Date.now().toString());
      const imagesDir = path.join(tempDir, 'Dataset', 'images');
      const textDir = path.join(tempDir, 'Dataset', 'text');
      fs.ensureDirSync(imagesDir);
      fs.ensureDirSync(textDir);
      
      // Verificăm dacă avem fișiere încărcate
      console.log(`Files in request: ${req.files?.length || 0}`);
      
      let processedBoxes = 0;
      
      // Modul multi-pagină (format nou)
      if (totalPages > 1 || Array.isArray(req.files) && req.files.length > 1) {
        console.log(`Procesăm ${totalPages} pagini în modul multi-pagină`);
        
        // Iterăm prin fiecare pagină
        for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
          let imagePath = null;
          let boxData = [];
          
          // Încercăm să găsim fișierul imagine pentru această pagină din req.files
          const pageImageFile = req.files?.find(f => f.fieldname === `images[${pageIndex}]`);
          
          if (pageImageFile) {
            imagePath = pageImageFile.path;
            console.log(`Pagina ${pageIndex+1}: Imagine găsită - ${pageImageFile.originalname}`);
          } else {
            console.log(`Pagina ${pageIndex+1}: Nu s-a găsit imagine în req.files`);
            continue; // Trecem la următoarea pagină dacă nu găsim imagine
          }
          
          // Obținem datele box pentru această pagină
          const boxDataJson = req.body[`boxData[${pageIndex}]`];
          if (boxDataJson) {
            try {
              boxData = JSON.parse(boxDataJson);
              console.log(`Pagina ${pageIndex+1}: ${boxData.length} boxuri găsite`);
            } catch (e) {
              console.error(`Eroare la parsarea boxData pentru pagina ${pageIndex+1}:`, e);
              continue;
            }
          } else {
            console.log(`Pagina ${pageIndex+1}: Nu s-au găsit date box`);
            continue;
          }
          
          // Obținem dimensiunea imaginii fie din parametri, fie din imagine
          let imageHeight = parseInt(req.body.imageHeight) || 0;
          let imageWidth = parseInt(req.body.imageWidth) || 0;
          
          if (!imageHeight || !imageWidth) {
            try {
              const metadata = await sharp(imagePath).metadata();
              imageHeight = metadata.height;
              imageWidth = metadata.width;
              console.log(`Dimensiuni imagine detectate: ${imageWidth}x${imageHeight}`);
            } catch (e) {
              console.error('Eroare la citirea dimensiunilor imaginii:', e);
              continue;
            }
          }
          
          // Procesăm fiecare box din această pagină
          for (let i = 0; i < boxData.length; i++) {
            const box = boxData[i];
            processedBoxes++;
            const num = processedBoxes.toString().padStart(4, '0');
            const pagePrefix = totalPages > 1 ? `page${(pageIndex+1).toString().padStart(3,'0')}_` : '';
            
            // Calculăm coordonatele pentru decupare
            const sx = Math.round(Math.min(box.x1, box.x2));
            const sy = Math.round(imageHeight - Math.max(box.y1, box.y2));
            const sw = Math.round(Math.abs(box.x2 - box.x1));
            const sh = Math.round(Math.abs(box.y2 - box.y1));
            
            if (sw <= 0 || sh <= 0) continue;
            
            const outImage = path.join(imagesDir, `${pagePrefix}line_${num}.png`);
            try {
              console.log(`Decupare box ${num} din pagina ${pageIndex+1}: ${sx},${sy} ${sw}x${sh}`);
              await sharp(imagePath).extract({ left: sx, top: sy, width: sw, height: sh }).png().toFile(outImage);
              fs.writeFileSync(path.join(textDir, `${pagePrefix}line_${num}.txt`), box.text || '');
            } catch (e) {
              console.error(`Eroare la procesarea box-ului ${num} din pagina ${pageIndex+1}:`, e);
            }
          }
        }
      } 
      // Modul single-page (compatibilitate cu formatul vechi)
      else {
        console.log('Procesăm în modul single-page (format vechi)');
        
        // Obținem imaginea și datele
        let imagePath;
        if (req.file) {
          imagePath = req.file.path;
          console.log(`Imagine încărcată direct: ${req.file.originalname}`);
        } else if (req.files && req.files.length > 0) {
          imagePath = req.files[0].path;
          console.log(`Imagine găsită în req.files: ${req.files[0].originalname}`);
        } else {
          return res.status(400).json({ error: 'No image found for dataset generation' });
        }
        
        // Obținem box data
        let boxData = [];
        if (req.body.boxData) {
          try {
            boxData = JSON.parse(req.body.boxData);
            console.log(`${boxData.length} boxuri găsite în modul single-page`);
          } catch (e) {
            console.error('Eroare la parsarea boxData:', e);
            return res.status(400).json({ error: 'Invalid box data format' });
          }
        }
        
        // Obținem dimensiunile imaginii
        const imageHeight = parseInt(req.body.imageHeight);
        const imageWidth = parseInt(req.body.imageWidth);
        
        if (!Array.isArray(boxData) || !imageHeight || !imageWidth) {
          return res.status(400).json({ error: 'Invalid parameters for dataset generation' });
        }
        
        // Procesăm fiecare box
        for (let i = 0; i < boxData.length; i++) {
          const box = boxData[i];
          processedBoxes++;
          const num = processedBoxes.toString().padStart(4, '0');
          
          const sx = Math.round(Math.min(box.x1, box.x2));
          const sy = Math.round(imageHeight - Math.max(box.y1, box.y2));
          const sw = Math.round(Math.abs(box.x2 - box.x1));
          const sh = Math.round(Math.abs(box.y2 - box.y1));
          
          if (sw <= 0 || sh <= 0) continue;
          
          const outImage = path.join(imagesDir, `line_${num}.png`);
          try {
            console.log(`Decupare box ${num}: ${sx},${sy} ${sw}x${sh}`);
            await sharp(imagePath).extract({ left: sx, top: sy, width: sw, height: sh }).png().toFile(outImage);
            fs.writeFileSync(path.join(textDir, `line_${num}.txt`), box.text || '');
          } catch (e) {
            console.error(`Eroare la procesarea box-ului ${num}:`, e);
          }
        }
      }
      
      // Verificăm dacă am procesat cel puțin un box
      if (processedBoxes === 0) {
        fs.removeSync(tempDir);
        return res.status(400).json({ error: 'No valid boxes to process' });
      }
      
      // Creăm și trimitem arhiva ZIP
      const zipPath = path.join(__dirname, 'downloads', `${datasetName}_Dataset.zip`);
      fs.ensureDirSync(path.dirname(zipPath));
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        console.log(`Arhivă creată: ${zipPath} (${archive.pointer()} bytes)`);
        res.download(zipPath, `${datasetName}_Dataset.zip`, err => {
          fs.remove(tempDir).catch(console.error);
          fs.remove(zipPath).catch(console.error);
        });
      });
      
      archive.on('error', err => {
        console.error('Eroare la crearea arhivei:', err);
        res.status(500).json({ error: 'ZIP creation failed: '+err.message });
      });
      
      archive.pipe(output);
      archive.directory(path.join(tempDir, 'Dataset'), 'Dataset');
      await archive.finalize();
      
      console.log('----- Generare dataset finalizată -----');
    } catch (error) {
      console.error('Dataset generation error:', error);
      res.status(500).json({ error: 'Dataset generation failed: '+error.message });
    }
  });
});

// Ruta pentru generarea dataset-ului pentru multiple pagini (folder)
app.post('/api/generate-multi-page-dataset', upload.none(), async (req, res) => {
  try {
    const totalPages = parseInt(req.body.totalPages) || 0;
    const datasetName = req.body.datasetName || 'dataset';
    const sessionId = req.body.sessionId;
    if (!sessionId) return res.status(400).json({ error: 'SessionId is required' });
    console.log(`Multi-page dataset: session=${sessionId}, pages=${totalPages}`);

    if (totalPages < 1) return res.status(400).json({ error: 'Invalid totalPages' });

    const tempDir = path.join(__dirname, 'temp', Date.now().toString());
    const imagesDir = path.join(tempDir, 'Dataset', 'images');
    const textDir = path.join(tempDir, 'Dataset', 'text');
    fs.ensureDirSync(imagesDir);
    fs.ensureDirSync(textDir);

    // Log all form fields for debugging
    console.log('Form data fields:', Object.keys(req.body));
    
    // Debug sessionId path
    const sessionDir = path.join(__dirname, 'uploads', sessionId);
    const sessionDirExists = fs.existsSync(sessionDir);
    console.log(`Session directory ${sessionDir} exists: ${sessionDirExists}`);
    if (sessionDirExists) {
      console.log('Files in session directory:', fs.readdirSync(sessionDir));
    }

    let pageCount = 0, boxCount = 0;
    for (let i = 0; i < totalPages; i++) {
      const boxDataField = `boxData_${i}`;
      const imageHeightField = `imageHeight_${i}`;
      const imageWidthField = `imageWidth_${i}`;
      const imageNameField = `imageFileName_${i}`;
      
      // Debug field presence
      console.log(`Page ${i} fields present:`, {
        boxData: !!req.body[boxDataField],
        height: !!req.body[imageHeightField],
        width: !!req.body[imageWidthField],
        fileName: req.body[imageNameField] || 'MISSING'
      });
      
      if (!req.body[boxDataField] || !req.body[imageNameField]) continue;
      const boxes = JSON.parse(req.body[boxDataField]);
      const imageHeight = parseInt(req.body[imageHeightField] || 0);
      const imageWidth = parseInt(req.body[imageWidthField] || 0);
      const fileName = req.body[imageNameField];
      
      // Try multiple path variants to find the correct file
      let imagePath = path.join(__dirname, 'uploads', sessionId, fileName);
      let imageExists = fs.existsSync(imagePath);
      
      // Debug file access
      console.log(`Page ${i} image path: ${imagePath}, exists: ${imageExists}`);
      
      if (!imageExists) {
        // Try to find by just the filename
        const allSessionFiles = sessionDirExists ? fs.readdirSync(sessionDir) : [];
        const possibleMatches = allSessionFiles.filter(f => f.includes(path.basename(fileName)));
        console.log(`Possible matches for ${fileName}:`, possibleMatches);
        
        // If we found potential matches, try the first one
        if (possibleMatches.length > 0) {
          const alternativePath = path.join(sessionDir, possibleMatches[0]);
          console.log(`Trying alternative path: ${alternativePath}`);
          if (fs.existsSync(alternativePath)) {
            imagePath = alternativePath;
            imageExists = true;
            console.log(`Found alternative path: ${imagePath}`);
          }
        }
        
        // Try with decoded filename
        if (!imageExists) {
          try {
            const decodedFileName = decodeURIComponent(fileName);
            const decodedPath = path.join(sessionDir, decodedFileName);
            console.log(`Trying decoded path: ${decodedPath}`);
            if (fs.existsSync(decodedPath)) {
              imagePath = decodedPath;
              imageExists = true;
              console.log(`Found with decoded filename: ${imagePath}`);
            }
          } catch (e) {
            console.log(`Error decoding filename: ${e.message}`);
          }
        }
      }
      
      // Skip if we couldn't find the image
      if (!imageExists) {
        console.log(`Skipping page ${i} - image not found`);
        continue;
      }
      
      for (let j = 0; j < boxes.length; j++) {
        const box = boxes[j];
        const num = (boxCount+1).toString().padStart(4,'0');
        const sx = Math.round(Math.min(box.x1, box.x2));
        const sy = Math.round(imageHeight - Math.max(box.y1, box.y2));
        const sw = Math.round(Math.abs(box.x2 - box.x1));
        const sh = Math.round(Math.abs(box.y2 - box.y1));
        if (sw <=0||sh<=0) continue;
        const outImg = path.join(imagesDir, `page${(i+1).toString().padStart(3,'0')}_line_${num}.png`);
        try {
          await sharp(imagePath).extract({ left: sx, top: sy, width: sw, height: sh }).png().toFile(outImg);
          fs.writeFileSync(path.join(textDir, `page${(i+1).toString().padStart(3,'0')}_line_${num}.txt`), box.text||'');
        } catch(e){}
        boxCount++;
      }
      pageCount++;
    }
    if (pageCount===0) return res.status(400).json({ error:'No pages processed' });

    const zipPath = path.join(__dirname, 'downloads', `${datasetName}_Dataset.zip`);
    fs.ensureDirSync(path.dirname(zipPath));
    const output = fs.createWriteStream(zipPath), archive = archiver('zip',{ zlib:{level:9} });
    output.on('close',()=>{res.download(zipPath, `${datasetName}_Dataset.zip`, ()=>{fs.remove(tempDir);fs.remove(zipPath);});});
    archive.on('error',err=>res.status(500).json({error:err.message}));
    archive.pipe(output);
    archive.directory(path.join(tempDir,'Dataset'),'Dataset');
    archive.finalize();
  } catch(error) { res.status(500).json({ error:error.message }); }
});

// Rută de diagnostic pentru a verifica disponibilitatea fișierelor procesate
app.get('/api/diagnostics/processed-files', (req, res) => {
  try {
    const processedDir = path.join(__dirname, 'processed');
    
    if (!fs.existsSync(processedDir)) {
      return res.json({
        exists: false,
        message: `Directorul ${processedDir} nu există`,
        canCreate: true
      });
    }
    
    const stats = fs.statSync(processedDir);
    const files = fs.readdirSync(processedDir);
    
    return res.json({
      exists: true,
      isDirectory: stats.isDirectory(),
      files: files.map(file => ({
        name: file,
        size: fs.statSync(path.join(processedDir, file)).size,
        path: path.join(processedDir, file)
      })),
      totalFiles: files.length
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Eroare la diagnosticare',
      message: error.message,
      stack: error.stack
    });
  }
});

// Servim fișierele din uploads și processed pentru debugging
app.use('/debug/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/debug/processed', express.static(path.join(__dirname, 'processed')));

// Add direct access to processed files for frontends
app.use('/processed', express.static(path.join(__dirname, 'processed')));

// Servim fișiere statice din directorul curent al proiectului
app.use(express.static(path.join(__dirname, '..')));

// Ruta implicită
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// New endpoint for folder uploads
app.post('/api/upload-folder', (req, res) => {
  debugLog("Folder upload request received");
  
  // Add more debugging to understand the request
  console.log('Headers:', req.headers);
  
  folderUpload(req, res, async (err) => {
    if (err) {
      console.error('Error uploading folder:', err);
      return res.status(400).json({ error: 'Error uploading folder: ' + err.message });
    }

    try {
      debugLog('Processing folder upload, files received:', req.files?.length || 0);
      
      // Log the entire files array for debugging
      console.log('Files received:', JSON.stringify(req.files?.map(f => ({
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        path: f.path
      })) || [], null, 2));
      
      // Check if files exist and have correct format
      if (!req.files || req.files.length === 0) {
        console.error('No files were uploaded!');
        
        // Check if there are files in the request but not properly processed
        if (req.body && Object.keys(req.body).length > 0) {
          console.log('Request body contains:', Object.keys(req.body));
        }
        
        return res.status(400).json({ error: 'No files were uploaded' });
      }
      
      // Retrieve sessionId from query or body
      const sessionId = req.query.sessionId || req.body.sessionId || Date.now().toString();
      debugLog(`Session ID: ${sessionId}`);
      
      const uploadDir = path.join(__dirname, 'uploads', sessionId);
      fs.ensureDirSync(uploadDir);
      
      // Categorize files
      const imageFiles = [];
      const boxFiles = [];
      
      req.files.forEach(file => {
        const fileExtension = path.extname(file.originalname).toLowerCase();
        
        // Get relative path for use in client
        let relPath = '';
        try {
          relPath = path.relative(path.join(__dirname, 'uploads'), file.path);
        } catch (error) {
          console.error(`Error getting relative path for ${file.originalname}:`, error);
          relPath = file.path; // Fallback
        }
        
        const fileInfo = {
          name: file.originalname,
          path: file.path,
          relativePath: relPath,
          size: file.size,
          type: file.mimetype
        };
        
        if (['.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff', '.pdf'].includes(fileExtension)) {
          debugLog(`Adding image file: ${file.originalname}`);
          imageFiles.push(fileInfo);
        } else if (fileExtension === '.box') {
          debugLog(`Adding box file: ${file.originalname}`);
          boxFiles.push(fileInfo);
        } else {
          debugLog(`Skipping unsupported file: ${file.originalname}`);
        }
      });
      
      // Sort files by name
      imageFiles.sort((a, b) => a.name.localeCompare(b.name));
      boxFiles.sort((a, b) => a.name.localeCompare(b.name));
      
      debugLog(`Categorized ${imageFiles.length} image files and ${boxFiles.length} box files`);
      
      // Match box files with images
      for (const boxFile of boxFiles) {
        const boxBaseName = path.basename(boxFile.name, '.box');
        const matchingImageIndex = imageFiles.findIndex(img => 
          img.name.includes(boxBaseName) || boxBaseName.includes(path.basename(img.name, path.extname(img.name)))
        );
        
        if (matchingImageIndex >= 0) {
          debugLog(`Matched box file ${boxFile.name} with image ${imageFiles[matchingImageIndex].name}`);
          imageFiles[matchingImageIndex].matchingBoxFile = boxFile;
        }
      }
      
      // Process TIFF files if needed (asynchronously)
      const tiffProcessingPromises = [];
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        const fileExtension = path.extname(file.name).toLowerCase();
        
        if (['.tif', '.tiff'].includes(fileExtension)) {
          tiffProcessingPromises.push((async (index) => {
            try {
              const processedDir = path.join(__dirname, 'processed');
              fs.ensureDirSync(processedDir);
              
              const outputBaseName = path.basename(file.name, fileExtension);
              const outputPath = path.join(processedDir, `${sessionId}_${outputBaseName}.png`);
              
              debugLog(`Processing TIFF: ${file.path} -> ${outputPath}`);
              
              await sharp(file.path)
                .png()
                .toFile(outputPath);
              
              debugLog(`TIFF processed successfully: ${outputPath}`);
              
              // Update the file info with processed data
              let processedRelPath = '';
              try {
                processedRelPath = path.relative(path.join(__dirname, 'uploads'), outputPath);
              } catch (error) {
                console.error(`Error getting relative path for processed TIFF:`, error);
                processedRelPath = outputPath; // Fallback
              }
              
              imageFiles[index].processedPath = outputPath;
              imageFiles[index].relativePath = processedRelPath;
              imageFiles[index].isProcessed = true;
            } catch (error) {
              console.error(`Error processing TIFF file ${file.name}:`, error);
            }
          })(i));
        }
      }
      
      // Wait for all TIFF processing to finish if needed
      if (tiffProcessingPromises.length > 0) {
        debugLog(`Processing ${tiffProcessingPromises.length} TIFF files...`);
        try {
          await Promise.all(tiffProcessingPromises);
          debugLog('All TIFF files processed successfully');
        } catch (error) {
          console.error('Error processing TIFF files:', error);
          // Continue despite errors
        }
      }
      
      debugLog(`Sending response with ${imageFiles.length} images and ${boxFiles.length} boxes`);
      
      // Log the final counts before sending the response
      console.log(`[process-folder] Final counts - Images: ${imageFiles.length}, Boxes: ${boxFiles.length}`);
      
      return res.json({
        success: true,
        sessionId: sessionId,
        totalFiles: req.files.length,
        images: imageFiles,
        boxes: boxFiles,
        message: "Files uploaded successfully"
      });
      
    } catch (error) {
      console.error('Error processing folder upload:', error);
      return res.status(500).json({ error: 'Error processing folder upload: ' + error.message });
    }
  });
});

// Add endpoint to retrieve an image by its path
app.get('/api/get-image/:sessionId/:filename', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const filename = req.params.filename;
    
    debugLog(`Image request for sessionId: ${sessionId}, filename: ${filename}`);
    
    // Check for directory traversal attacks
    if (filename.includes('..') || sessionId.includes('..')) {
      console.error(`Suspicious path detected: ${sessionId}/${filename}`);
      return res.status(403).json({ error: 'Invalid path' });
    }
    
    const fileExtension = path.extname(filename).toLowerCase();
    const isOriginalTiff = ['.tif', '.tiff'].includes(fileExtension);
    const baseName = path.basename(filename, fileExtension);
    
    // Try different possible locations for the file, prioritizing processed PNGs for TIFFs
    const possiblePaths = [];
    
    // For TIFF files, prioritize the processed PNG versions
    if (isOriginalTiff) {
      // Path for processed TIFF files with session prefix
      possiblePaths.push(path.join(__dirname, 'processed', `${sessionId}_${baseName}.png`));
      
      // Fallback processed path with spaces instead of underscores (some filenames have spaces replaced)
      possiblePaths.push(path.join(__dirname, 'processed', `${sessionId}_${baseName.replace(/_/g, ' ')}.png`));
      
      // Fallback processed path without session prefix
      possiblePaths.push(path.join(__dirname, 'processed', `${baseName}.png`));
      
      // Fallback processed path without session prefix and with spaces
      possiblePaths.push(path.join(__dirname, 'processed', `${baseName.replace(/_/g, ' ')}.png`));
    }
    
    // After trying processed versions of TIFFs, continue with the original paths
    // Direct path in the session uploads folder
    possiblePaths.push(path.join(__dirname, 'uploads', sessionId, filename));
    
    // Path in the main uploads folder (for backward compatibility)
    possiblePaths.push(path.join(__dirname, 'uploads', filename));
    
    // Try each path
    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath)) {
        debugLog(`Found file at: ${filePath}`);
        return res.sendFile(filePath);
      }
    }
    
    // If we get here, the file wasn't found
    debugLog(`File not found: ${sessionId}/${filename}`);
    debugLog(`Tried paths: ${possiblePaths.join(', ')}`);
    
    return res.status(404).json({ 
      error: 'File not found',
      sessionId: sessionId,
      filename: filename,
      triedPaths: possiblePaths
    });
  } catch (error) {
    console.error('Error retrieving image:', error);
    return res.status(500).json({ error: 'Error retrieving image: ' + error.message });
  }
});

// --- Save individual page box data ---
app.post('/api/save-page-data', async (req, res) => {
  try {
    const { sessionId, imageFileName, boxData } = req.body;
    
    if (!sessionId || !imageFileName || boxData === undefined) {
      debugLog('Save page data error: Missing required parameters');
      return res.status(400).json({ error: 'Missing sessionId, imageFileName, or boxData' });
    }
    
    debugLog(`[Page Data ${sessionId}] Saving data for page: ${imageFileName}, boxes: ${boxData.length}`);
    
    // Ensure session directory exists
    const sessionDir = path.join(__dirname, 'uploads', sessionId);
    fs.ensureDirSync(sessionDir);
    
    // Create a safe filename for the JSON file
    const safeName = path.basename(imageFileName);
    const jsonPath = path.join(sessionDir, `${safeName}.boxes.json`);
    
    // Format the data for storage
    const pageData = { 
      imageName: safeName, 
      boxes: boxData,
      saved: new Date().toISOString()
    };
    
    // Write the JSON file
    await fs.writeJson(jsonPath, pageData);
    
    debugLog(`[Page Data ${sessionId}] Saved ${boxData.length} boxes for ${safeName}`);
    
    res.json({ 
      success: true, 
      message: `Saved data for ${safeName}`,
      boxes: boxData.length
    });
  } catch (err) {
    console.error('Error saving page data:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Retrieve saved page box data (JSON) ---
app.get('/api/get-page-data/:sessionId/:imageFileName', async (req, res) => {
  const { sessionId, imageFileName } = req.params;
  const safeName = path.basename(imageFileName);
  const jsonPath = path.join(__dirname, 'uploads', sessionId, `${safeName}.boxes.json`);
  if (fs.existsSync(jsonPath)) {
    try {
      const data = await fs.readJson(jsonPath);
      return res.json({ boxes: data.boxes || [] });
    } catch (err) {
      console.error('Error reading page data:', err);
      return res.status(500).json({ error: err.message });
    }
  }
  res.status(404).json({ boxes: [] });
});

// Endpoint to process a folder of files after they've been uploaded
app.post('/api/process-folder', async (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  
  try {
    debugLog(`Processing folder for session ${sessionId}`);
    
    // Create the session directory if it doesn't exist
    const sessionDir = path.join(__dirname, 'uploads', sessionId);
    fs.ensureDirSync(sessionDir);
    
    // Get all files in the session directory
    const files = fs.readdirSync(sessionDir);
    debugLog(`Found ${files.length} files in session directory`);
    
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files found in session directory' });
    }
    
    // Categorize files by type
    const imageFiles = [];
    const boxFiles = [];
    
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stats = fs.statSync(filePath);
      const ext = path.extname(file).toLowerCase();
      
      if (['.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff', '.pdf'].includes(ext)) {
        imageFiles.push({
          filename: file,
          path: filePath,
          size: stats.size,
          name: path.basename(file, ext)
        });
      } else if (ext === '.box') {
        boxFiles.push({
          filename: file,
          path: filePath,
          size: stats.size,
          name: path.basename(file, ext)
        });
      }
    }
    
    // Sort both arrays by name for consistent ordering
    imageFiles.sort((a, b) => a.name.localeCompare(b.name));
    boxFiles.sort((a, b) => a.name.localeCompare(b.name));
    
    debugLog(`Found ${imageFiles.length} image files and ${boxFiles.length} box files`);
    
    // Match box files with images
    for (const imageFile of imageFiles) {
      // Find a box file with the same name
      const matchingBoxFile = boxFiles.find(boxFile => 
        boxFile.name === imageFile.name || 
        imageFile.name.includes(boxFile.name) || 
        boxFile.name.includes(imageFile.name)
      );
      
      if (matchingBoxFile) {
        debugLog(`Matched ${imageFile.filename} with box file ${matchingBoxFile.filename}`);
        imageFile.boxFilePath = matchingBoxFile.path;
        imageFile.boxFileName = matchingBoxFile.filename;
      }
    }
    
    // Log the final counts before sending the response
    console.log(`[process-folder] Final counts - Images: ${imageFiles.length}, Boxes: ${boxFiles.length}`);
    
    // Return information about the processed files
    return res.json({
      success: true,
      sessionId,
      totalImages: imageFiles.length,
      totalBoxFiles: boxFiles.length,
      images: imageFiles,
      message: 'Files processed successfully'
    });
    
  } catch (error) {
    console.error('Error processing folder:', error);
    return res.status(500).json({ error: 'Error processing folder: ' + error.message });
  }
});

// Endpoint to get a box file by session ID and filename
app.get('/api/get-box-file/:sessionId/:imageFilename', (req, res) => {
  try {
    const { sessionId, imageFilename } = req.params;
    
    // Make sure paths are safe
    if (sessionId.includes('..') || imageFilename.includes('..')) {
      return res.status(403).json({ error: 'Invalid path' });
    }
    
    const sessionDir = path.join(__dirname, 'uploads', sessionId);
    
    // Get the image name without extension
    const imageName = path.basename(imageFilename, path.extname(imageFilename));
    
    // Look for a matching box file
    const files = fs.readdirSync(sessionDir);
    const boxFile = files.find(file => 
      file.endsWith('.box') && 
      (path.basename(file, '.box') === imageName || 
       imageName.includes(path.basename(file, '.box')) ||
       path.basename(file, '.box').includes(imageName))
    );
    
    if (!boxFile) {
      return res.status(404).json({ error: 'Box file not found' });
    }
    
    const boxFilePath = path.join(sessionDir, boxFile);
    const boxContent = fs.readFileSync(boxFilePath, 'utf8');
    
    res.type('text/plain').send(boxContent);
  } catch (error) {
    console.error('Error retrieving box file:', error);
    res.status(500).json({ error: 'Error retrieving box file: ' + error.message });
  }
});

// New endpoint to download the aggregated dataset for a folder session
app.get('/api/download-final-dataset', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'SessionId is required' });
  }
  if (sessionId.includes('..')) {
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }
  try {
    const sessionDir = path.join(__dirname, 'uploads', sessionId);
    if (!fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: 'Session not found or no data stored.' });
    }
    
    // Enhanced logging
    debugLog(`[Dataset ${sessionId}] Starting dataset generation`);
    
    // Prepare temp directories
    const tempDir = path.join(__dirname, 'temp', `dataset_${sessionId}_${Date.now()}`);
    const imagesDir = path.join(tempDir, 'Dataset', 'images');
    const textDir   = path.join(tempDir, 'Dataset', 'text');
    fs.ensureDirSync(imagesDir);
    fs.ensureDirSync(textDir);
    
    // Prepare records for metadata.csv
    const metadataRecords = [];
    
    let boxCount = 0;
    let pagesProcessed = 0;
    
    // List all files in the session directory for debugging
    const filesInSession = fs.readdirSync(sessionDir);
    debugLog(`[Dataset ${sessionId}] Found ${filesInSession.length} files in session dir`);
    
    // For each saved page JSON
    for (const fileInDir of filesInSession) {
      if (!fileInDir.endsWith('.boxes.json')) continue;
      
      const boxJsonFilePath = path.join(sessionDir, fileInDir);
      debugLog(`[Dataset ${sessionId}] Processing JSON file: ${boxJsonFilePath}`);
      
      try {
        const pageData = await fs.readJson(boxJsonFilePath);
        const boxes = pageData.boxes || [];
        const origNameEncoded = pageData.imageName;
        
        // Decode the filename for display and searching purposes
        const origNameDecoded = decodeURIComponent(origNameEncoded);
        
        debugLog(`[Dataset ${sessionId}] Original filename: ${origNameDecoded}, Boxes found: ${boxes.length}`);
        
        if (!boxes || boxes.length === 0) {
          debugLog(`[Dataset ${sessionId}] Skipping ${origNameDecoded} - no boxes.`);
          continue;
        }
        
        // --- Enhanced Image Path Finding Logic ---
        // Try multiple ways to find the image file
        
        // 1. Direct path with encoded name
        let imagePath = path.join(sessionDir, origNameEncoded);
        let foundImage = false;
        
        debugLog(`[Dataset ${sessionId}] Checking direct path with encoded name: ${imagePath}`);
        if (fs.existsSync(imagePath)) {
          debugLog(`[Dataset ${sessionId}] Image found directly with encoded name.`);
          foundImage = true;
        } 
        
        // 2. Direct path with decoded name
        if (!foundImage) {
          imagePath = path.join(sessionDir, origNameDecoded);
          debugLog(`[Dataset ${sessionId}] Checking direct path with decoded name: ${imagePath}`);
          if (fs.existsSync(imagePath)) {
            debugLog(`[Dataset ${sessionId}] Image found directly with decoded name.`);
            foundImage = true;
          }
        }
        
        // 3. Check if the file exists with a sanitized filename (removing special chars)
        if (!foundImage) {
          const sanitizedName = origNameDecoded.replace(/[^a-zA-Z0-9.-]/g, '_');
          imagePath = path.join(sessionDir, sanitizedName);
          debugLog(`[Dataset ${sessionId}] Checking sanitized name: ${imagePath}`);
          if (fs.existsSync(imagePath)) {
            debugLog(`[Dataset ${sessionId}] Image found with sanitized name.`);
            foundImage = true;
          }
        }
        
        // 4. Check processed directory for TIFF/PDF conversions
        if (!foundImage) {
          const baseName = path.basename(origNameDecoded, path.extname(origNameDecoded));
          
          // With session prefix
          const processedPngName = `${sessionId}_${baseName}.png`;
          let processedPngPath = path.join(__dirname, 'processed', processedPngName);
          
          debugLog(`[Dataset ${sessionId}] Checking processed path with session prefix: ${processedPngPath}`);
          if (fs.existsSync(processedPngPath)) {
            imagePath = processedPngPath;
            debugLog(`[Dataset ${sessionId}] Found processed image with session prefix.`);
            foundImage = true;
          } 
          
          // Without session prefix
          if (!foundImage) {
            processedPngPath = path.join(__dirname, 'processed', `${baseName}.png`);
            debugLog(`[Dataset ${sessionId}] Checking processed path without prefix: ${processedPngPath}`);
            if (fs.existsSync(processedPngPath)) {
              imagePath = processedPngPath;
              debugLog(`[Dataset ${sessionId}] Found processed image without prefix.`);
              foundImage = true;
            }
          }
        }
        
        // 5. Last attempt - try to find any file with a similar name in the session directory
        if (!foundImage) {
          debugLog(`[Dataset ${sessionId}] Trying fuzzy filename matching...`);
          const baseNameDecoded = path.basename(origNameDecoded, path.extname(origNameDecoded));
          
          // Look for files that contain the base name
          const possibleMatches = filesInSession.filter(f => 
            !f.endsWith('.boxes.json') && 
            (f.includes(baseNameDecoded) || baseNameDecoded.includes(path.basename(f, path.extname(f))))
          );
          
          if (possibleMatches.length > 0) {
            imagePath = path.join(sessionDir, possibleMatches[0]);
            debugLog(`[Dataset ${sessionId}] Found potential match: ${possibleMatches[0]}`);
            if (fs.existsSync(imagePath)) {
              foundImage = true;
              debugLog(`[Dataset ${sessionId}] Using fuzzy-matched file: ${imagePath}`);
            }
          }
        }
        
        if (!foundImage) {
          console.warn(`[Dataset ${sessionId}] Image file for "${origNameDecoded}" not found after all attempts. Skipping this page.`);
          continue;
        }
        
        debugLog(`[Dataset ${sessionId}] Using image for cropping: ${imagePath}`);
        // --- End Enhanced Image Path Finding ---
        
        // Get image dimensions
        let metadata;
        try {
          metadata = await sharp(imagePath).metadata();
        } catch (metadataError) {
          console.error(`[Dataset ${sessionId}] Error getting metadata for ${imagePath}:`, metadataError);
          continue;
        }
        
        const height = metadata.height;
        debugLog(`[Dataset ${sessionId}] Image dimensions: ${metadata.width}x${height}`);
        
        // Process each box
        for (const box of boxes) {
          try {
            const sx = Math.round(Math.min(box.x1, box.x2));
            const sy = Math.round(height - Math.max(box.y1, box.y2));
            const sw = Math.round(Math.abs(box.x2 - box.x1));
            const sh = Math.round(Math.abs(box.y2 - box.y1));
            
            if (sw <= 0 || sh <= 0) {
              debugLog(`[Dataset ${sessionId}] Skipping box with invalid dimensions: ${sw}x${sh}`);
              continue;
            }
            
            boxCount++;
            const num = boxCount.toString().padStart(5, '0');
            
            // Generate safe base name for output files
            const safeBase = origNameDecoded.replace(/[^a-zA-Z0-9_.-]/g,'_').replace(/\.[^/.]+$/, '');
            const outImg = path.join(imagesDir, `${safeBase}_line_${num}.png`);
            const outTxt = path.join(textDir, `${safeBase}_line_${num}.txt`);
            
            debugLog(`[Dataset ${sessionId}] Cropping box ${num}: ${sx},${sy} ${sw}x${sh}`);
            
            await sharp(imagePath)
              .extract({ left: sx, top: sy, width: sw, height: sh })
              .png()
              .toFile(outImg);
              
            fs.writeFileSync(outTxt, box.text || '');
            // Record metadata entry
            const relImgPath = `Dataset/images/${safeBase}_line_${num}.png`;
            metadataRecords.push({ file: relImgPath, text: box.text || '' });
            debugLog(`[Dataset ${sessionId}] Box ${num} processed successfully`);
          } catch (cropErr) {
            console.error(`[Dataset ${sessionId}] Error cropping box for ${origNameDecoded}, line ${boxCount}:`, cropErr);
          }
        }
        
        pagesProcessed++;
        debugLog(`[Dataset ${sessionId}] Page ${pagesProcessed} (${origNameDecoded}) processed with ${boxes.length} boxes`);
      } catch (jsonErr) {
        console.error(`[Dataset ${sessionId}] Error processing JSON file ${fileInDir}:`, jsonErr);
      }
    }
    
    debugLog(`[Dataset ${sessionId}] Processing complete. Pages: ${pagesProcessed}, Total boxes: ${boxCount}`);
    
    if (boxCount === 0) {
      fs.removeSync(tempDir);
      return res.status(404).json({ error: 'No boxes found for dataset.' });
    }
    
    // Generate metadata.csv in tempDir
    const metadataPath = path.join(tempDir, 'metadata.csv');
    const metadataLines = ['file_name,text'];
    for (const rec of metadataRecords) {
      // Escape double quotes in text
      const safeText = rec.text.replace(/"/g, '""');
      metadataLines.push(`${rec.file},"${safeText}"`);
    }
    fs.writeFileSync(metadataPath, metadataLines.join('\n'));
    debugLog(`[Dataset ${sessionId}] metadata.csv created with ${metadataRecords.length} entries`);
    
    // Create ZIP
    const zipName = `dataset_${sessionId}_Dataset.zip`;
    const zipPath = path.join(__dirname, 'downloads', zipName);
    fs.ensureDirSync(path.dirname(zipPath));
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      debugLog(`[Dataset ${sessionId}] ZIP created successfully: ${archive.pointer()} bytes`);
      res.download(zipPath, zipName, err => {
        fs.removeSync(tempDir);
        fs.removeSync(zipPath);
      });
    });
    
    archive.on('error', err => {
      fs.removeSync(tempDir);
      console.error(`[Dataset ${sessionId}] ZIP creation error:`, err);
      res.status(500).json({ error: 'ZIP creation failed: ' + err.message });
    });
    
    archive.pipe(output);
    archive.directory(path.join(tempDir, 'Dataset'), 'Dataset');
    // Include metadata.csv at root of ZIP
    archive.file(metadataPath, { name: 'metadata.csv' });
    archive.finalize();
    
    debugLog(`[Dataset ${sessionId}] Dataset generation process complete`);
  } catch (err) {
    console.error('Dataset download error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Pornim serverul
app.listen(PORT, () => {
  console.log(`Serverul rulează pe portul ${PORT}`);
  console.log(`Accesați http://localhost:${PORT}`);
  
  // Creăm directoarele necesare dacă nu există
  const dirs = [
    path.join(__dirname, 'uploads'),
    path.join(__dirname, 'processed'),
    path.join(__dirname, 'cropped'),
    path.join(__dirname, 'temp'),
    path.join(__dirname, 'downloads')
  ];
  
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Director creat: ${dir}`);
    } else {
      console.log(`Director existent: ${dir}`);
    }
  });
}); 