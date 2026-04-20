import { NextResponse } from 'next/server';
import { google } from 'googleapis';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, mimeType, size } = body;
    
    // Safety check on user input
    if (!name || !mimeType || typeof size !== 'number') {
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }
    
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    // Replace literal "\n" sequence out of standard strings to actual newlines for the PEM format
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'); 
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (!clientEmail || !privateKey || !folderId) {
       console.error("Missing Google Credentials in ENV", {
         hasEmail: !!clientEmail,
         hasKey: !!privateKey,
         hasFolder: !!folderId
       });
       return NextResponse.json({ error: "Server Configuration Error" }, { status: 500 });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey,
      },
      // Using 'drive.file' scope for security - limits access to only files the service app creates!
      scopes: ['https://www.googleapis.com/auth/drive.file'], 
    });

    // Determine the exact extension based on the actual mimeType
    let extension = 'webm';
    if (mimeType.includes('mp4')) extension = 'mp4';
    else if (mimeType.includes('quicktime')) extension = 'mov';

    // Generate a safe file name using the user's submitted name
    const dateStr = new Date().toISOString().split('T')[0];
    const rawName = `${name}_Video_${dateStr}.${extension}`;
    // Clean to prevent funny characters
    const filename = rawName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');

    // To get the raw resumable upload URL, we fetch the Google Drive REST API directly with our auth token.
    const token = await auth.getAccessToken();
    
    if (!token) {
        return NextResponse.json({ error: "Could not retrieve access token" }, { status: 500 });
    }

    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, {
       method: 'POST',
       headers: {
         'Authorization': `Bearer ${token}`,
         'Content-Type': 'application/json',
         'X-Upload-Content-Type': mimeType,
         'X-Upload-Content-Length': size.toString()
       },
       body: JSON.stringify({
         name: filename,
         parents: [folderId]
       })
    });

    if (!res.ok) {
       const text = await res.text();
       console.error("Google Drive API Error:", text, "Status:", res.status);
       return NextResponse.json({ error: "Failed to initialize upload in Google Drive" }, { status: res.status });
    }

    // The unique session upload URL is returned in the 'Location' header
    const uploadUrl = res.headers.get('location');

    if (!uploadUrl) {
       return NextResponse.json({ error: "Google Drive did not return an upload URL" }, { status: 500 });
    }

    // Send the URL back to the client so it can do a direct PUT request to Google Drive
    return NextResponse.json({ uploadUrl });
    
  } catch (error) {
    console.error("Error creating upload session:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
