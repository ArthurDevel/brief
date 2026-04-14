import StandaloneCallClient from "./StandaloneCallClient";

interface CallPageProps {
  searchParams: Promise<{
    autostart?: string;
  }>;
}

export default async function CallPage(props: CallPageProps) {
  const searchParams = await props.searchParams;

  return <StandaloneCallClient autostart={searchParams.autostart === "1"} />;
}
