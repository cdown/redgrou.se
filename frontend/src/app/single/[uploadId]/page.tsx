import { notFound } from "next/navigation";
import { apiFetch, buildApiUrl, checkApiResponse, parseProtoResponse } from "@/lib/api";
import { UPLOAD_DETAILS_ROUTE } from "@/lib/generated/api_constants";
import { UploadDashboard, UploadMetadata } from "@/components/upload-dashboard";
import { UploadMetadata as UploadMetadataDecoder } from "@/lib/proto/redgrouse_api";

interface PageProps {
  params: Promise<{ uploadId: string }>;
}

export default async function Page({ params }: PageProps) {
  const { uploadId } = await params;

  let upload: UploadMetadata | null = null;

  try {
    const res = await apiFetch(
      buildApiUrl(UPLOAD_DETAILS_ROUTE, { upload_id: uploadId })
    );
    await checkApiResponse(res, "Upload not found");
    upload = await parseProtoResponse(res, UploadMetadataDecoder);
  } catch (error) {
    console.error("Failed to fetch upload:", error);
    notFound();
  }

  if (!upload) return notFound();

  return <UploadDashboard initialUpload={upload} />;
}
