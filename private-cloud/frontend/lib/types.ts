export type FileStatus = 'pending' | 'uploading' | 'completed' | 'failed';
export type Category = 'video' | 'image' | 'audio' | 'document' | 'archive' | 'other';

export interface DriveFile {
  id: number;
  type: 'file';
  filename: string;
  original_filename: string;
  file_size: number;
  mime_type: string;
  category: Category;
  sha256: string;
  folder_id: number | null;
  status: FileStatus;
  upload_progress: number;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  telegram_file_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  path?: string;
}

export interface Folder {
  id: number;
  type: 'folder';
  name: string;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  path?: string;
}

export interface Listing {
  folder: Folder | null;
  path: { id: number; name: string }[];
  folders: Folder[];
  files: DriveFile[];
}

export interface Me {
  id: number;
  username: string;
  is_admin: boolean;
  usage: { total_size: number; file_count: number; trash_count: number };
}

export interface ServerTask {
  id: number;
  file_id: number | null;
  filename: string;
  file_size: number;
  status: 'pending' | 'queued' | 'uploading' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  retry_count: number;
  error_message: string | null;
  chunk_size: number;
  total_chunks: number;
  received_chunks: number;
  received?: number[];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export type SortKey = 'name' | 'size' | 'updated' | 'type';
