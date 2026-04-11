// Exported for testing — allows jest.spyOn(navigate, 'to') to intercept calls
export const navigate = {
  to(url: string): void {
    window.location.href = url
  },
}

export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    navigate.to('/setup')
  }
  return res
}
