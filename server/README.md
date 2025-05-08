# Box Editor Server

Server Node.js pentru procesarea imaginilor și generarea dataset-urilor pentru aplicația Box Editor for Tesseract OCR.

## Instalare

```bash
# Instalarea dependințelor
npm install
```

## Rulare

```bash
# Rulare în modul de dezvoltare cu nodemon
npm run dev

# Rulare în modul de producție
npm start
```

Serverul va rula pe portul 3000 implicit. Pentru a schimba portul, setați variabila de mediu PORT.

## API

### Încărcare imagine
POST `/api/upload-image`
- Încarcă o imagine pe server
- FormData: `image` (fișier)

### Cropare imagine
POST `/api/crop-image`
- Cropează o porțiune din imagine
- FormData: 
  - `image` (fișier)
  - `x`, `y`, `width`, `height` (coordonate pentru cropare)

### Generare dataset
POST `/api/generate-dataset`
- Generează un dataset cu imagini cropate și fișiere text asociate
- FormData:
  - `image` (fișier)
  - `boxData` (JSON string cu datele box-urilor)
  - `imageHeight` (înălțimea imaginii originale)
  - `imageWidth` (lățimea imaginii originale)
  - `datasetName` (opțional, numele pentru arhiva ZIP generată)

## Structura proiectului

- `server.js` - Fișierul principal al serverului
- `uploads/` - Director pentru imaginile încărcate
- `cropped/` - Director pentru imaginile cropate
- `temp/` - Director pentru fișierele temporare ale dataset-ului
- `downloads/` - Director pentru arhivele ZIP generate 