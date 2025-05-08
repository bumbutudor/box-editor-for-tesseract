app.get('/api/download-final-dataset', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }
  if (sessionId.includes('..')) { // Basic security check
    return res.status(400).json({ error: 'Invalid sessionId.' });
  }

  const sessionUploadDir = path.join(__dirname, 'uploads', sessionId); // Where .boxes.json and original uploads are
  if (!fs.existsSync(sessionUploadDir)) {
    return res.status(404).json({ error: 'Session not found or no data stored.' });
  }

  debugLog(`[Dataset ${sessionId}] Starting dataset generation`);

  // Prepare temp directories for dataset assembly
  const tempDir = path.join(__dirname, 'temp', `dataset_${sessionId}_${Date.now()}`);
  const datasetImagesDir = path.join(tempDir, 'Dataset', 'images'); // Cropped images go here
  const datasetTextDir = path.join(tempDir, 'Dataset', 'text');     // Ground truth .txt files go here
  fs.ensureDirSync(datasetImagesDir);
  fs.ensureDirSync(datasetTextDir);

  let boxCount = 0;
  let pagesProcessed = 0;
  const filesInSession = fs.readdirSync(sessionUploadDir);
  debugLog(`[Dataset ${sessionId}] Found files in session dir:`, filesInSession);

  try {
    for (const fileInDir of filesInSession) {
      if (!fileInDir.endsWith('.boxes.json')) continue;

      const boxJsonFilePath = path.join(sessionUploadDir, fileInDir);
      debugLog(`[Dataset ${sessionId}] Processing JSON file: ${boxJsonFilePath}`);

      try {
        const pageData = await fs.readJson(boxJsonFilePath);
        const boxes = pageData.boxes || [];
        const origNameEncoded = pageData.imageName; // This is URL-encoded

        const origNameDecoded = decodeURIComponent(origNameEncoded);
        const sanitizedDiskFileName = origNameDecoded.replace(/[^a-zA-Z0-9.-]/g, '_');

        debugLog(`[Dataset ${sessionId}] Original Encoded Name: ${origNameEncoded}, Decoded: ${origNameDecoded}, Sanitized for Disk: ${sanitizedDiskFileName}`);
        debugLog(`[Dataset ${sessionId}] Processing Image (Sanitized Name): ${sanitizedDiskFileName}, Boxes found: ${boxes.length}`);

        if (!boxes || boxes.length === 0) {
          debugLog(`[Dataset ${sessionId}] Skipping ${sanitizedDiskFileName} - no boxes.`);
          continue;
        }

        let imagePathToCrop;
        let foundImageForCropping = false;
        const baseNameFromSanitized = path.basename(sanitizedDiskFileName, path.extname(sanitizedDiskFileName));

        const processedPngNameSessionPrefixed = `${sessionId}_${baseNameFromSanitized}.png`;
        const processedPngPathSessionPrefixed = path.join(__dirname, 'processed', processedPngNameSessionPrefixed);
        if (fs.existsSync(processedPngPathSessionPrefixed)) {
            imagePathToCrop = processedPngPathSessionPrefixed;
            foundImageForCropping = true;
            debugLog(`[Dataset ${sessionId}] Found session-prefixed processed TIFF image for cropping: ${imagePathToCrop}`);
        }

        if (!foundImageForCropping) {
            const originalFilePathInSessionUploads = path.join(sessionUploadDir, sanitizedDiskFileName);
            if (fs.existsSync(originalFilePathInSessionUploads)) {
                imagePathToCrop = originalFilePathInSessionUploads;
                foundImageForCropping = true;
                debugLog(`[Dataset ${sessionId}] Found original image in session uploads for cropping: ${imagePathToCrop}`);
            }
        }
        
        if (!foundImageForCropping && path.extname(sanitizedDiskFileName).match(/\.tiff?$/i)) {
            const fallbackProcessedPngName = `${baseNameFromSanitized}.png`;
            const fallbackProcessedPngPath = path.join(__dirname, 'processed', fallbackProcessedPngName);
            if (fs.existsSync(fallbackProcessedPngPath)) {
                imagePathToCrop = fallbackProcessedPngPath;
                foundImageForCropping = true;
                debugLog(`[Dataset ${sessionId}] Found fallback processed TIFF image for cropping: ${imagePathToCrop}`);
            }
        }

        if (!foundImageForCropping) {
          console.warn(`[Dataset ${sessionId}] Image file ${sanitizedDiskFileName} (derived from ${origNameEncoded}) not found for cropping after all attempts. Skipping this page.`);
          continue;
        }

        debugLog(`[Dataset ${sessionId}] Using image for cropping: ${imagePathToCrop}`);
        
        let imageMetadata;
        try {
          imageMetadata = await sharp(imagePathToCrop).metadata();
        } catch (metadataError) {
          console.error(`[Dataset ${sessionId}] Error getting metadata for ${imagePathToCrop}:`, metadataError);
          continue; 
        }
        const imageHeight = imageMetadata.height;
        debugLog(`[Dataset ${sessionId}] Image dimensions for cropping: ${imageMetadata.width}x${imageHeight}`);

        const safeBaseForOutput = baseNameFromSanitized; // Filename base for output lines

        for (const box of boxes) {
          try {
            // Calculate crop coordinates from box.x1,y1,x2,y2
            const sx = Math.round(Math.min(box.x1, box.x2));
            const sy = Math.round(imageHeight - Math.max(box.y1, box.y2)); // Correct y for top-left origin
            const sw = Math.round(Math.abs(box.x2 - box.x1));
            const sh = Math.round(Math.abs(box.y2 - box.y1));

            if (sw <= 0 || sh <= 0 || sx < 0 || sy < 0 || (sx + sw) > imageMetadata.width || (sy + sh) > imageHeight ) {
              debugLog(`[Dataset ${sessionId}] Skipping box with invalid or out-of-bounds dimensions: sx:${sx} sy:${sy} sw:${sw} sh:${sh} for image ${imageMetadata.width}x${imageHeight}`);
              continue;
            }
            
            boxCount++;
            const num = boxCount.toString().padStart(5, '0');
            const outImg = path.join(datasetImagesDir, `${safeBaseForOutput}_line_${num}.png`);
            const outTxt = path.join(datasetTextDir, `${safeBaseForOutput}_line_${num}.txt`);

            debugLog(`[Dataset ${sessionId}] Cropping box ${num}: sx:${sx}, sy:${sy}, w:${sw}, h:${sh} to ${outImg}`);
            
            await sharp(imagePathToCrop)
              .extract({ left: sx, top: sy, width: sw, height: sh })
              .png()
              .toFile(outImg);
              
            fs.writeFileSync(outTxt, box.text || ''); // Write the actual text content
            debugLog(`[Dataset ${sessionId}] Box ${num} processed successfully`);
          } catch (cropErr) {
            console.error(`[Dataset ${sessionId}] Error cropping box for ${safeBaseForOutput}, line ${boxCount}:`, cropErr);
          }
        }
        pagesProcessed++;
        debugLog(`[Dataset ${sessionId}] Page ${pagesProcessed} (${sanitizedDiskFileName}) processed with its boxes`);
      } catch (jsonErr) {
        console.error(`[Dataset ${sessionId}] Error processing JSON file ${fileInDir}:`, jsonErr);
      }
    }

    debugLog(`[Dataset ${sessionId}] Processing complete. Pages processed: ${pagesProcessed}, Total boxes generated: ${boxCount}`);
    
    if (boxCount === 0) {
      fs.removeSync(tempDir); // Clean up temp if no boxes
      return res.status(404).json({ error: 'No boxes found to generate the dataset.' });
    }
    
    // Create ZIP
    const zipName = `dataset_${sessionId}_Dataset.zip`;
    const zipPath = path.join(__dirname, 'downloads', zipName);
    fs.ensureDirSync(path.dirname(zipPath)); // Ensure downloads directory exists
    
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
      debugLog(`[Dataset ${sessionId}] ZIP created successfully: ${zipName} (${archive.pointer()} bytes)`);
      res.download(zipPath, zipName, (err) => {
        if (err) {
          console.error(`[Dataset ${sessionId}] Error sending ZIP file:`, err);
        }
        // Clean up temporary files
        fs.remove(tempDir).catch(e => console.error(`Error removing tempDir ${tempDir}:`, e));
        fs.remove(zipPath).catch(e => console.error(`Error removing zipPath ${zipPath}:`, e));
      });
    });
    
    archive.on('error', err => {
      fs.remove(tempDir).catch(e => console.error(`Error removing tempDir ${tempDir} after archive error:`, e));
      console.error(`[Dataset ${sessionId}] ZIP creation error:`, err);
      res.status(500).json({ error: 'ZIP creation failed: ' + err.message });
    });
    
    archive.pipe(output);
    archive.directory(path.join(tempDir, 'Dataset'), 'Dataset'); // Add the 'Dataset' folder from tempDir to the zip
    archive.finalize();
    
    debugLog(`[Dataset ${sessionId}] Dataset generation and zipping process initiated.`);
  } catch (err) {
    // General error handling for the entire route
    console.error('Overall dataset download error:', err);
    // Clean up tempDir if it exists and an error occurred before zipping started
    if (tempDir && fs.existsSync(tempDir)) {
      fs.remove(tempDir).catch(e => console.error(`Error removing tempDir ${tempDir} in general catch:`, e));
    }
    res.status(500).json({ error: err.message || 'An unexpected error occurred during dataset generation.' });
  }
}); 