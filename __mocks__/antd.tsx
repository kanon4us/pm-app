/**
 * Minimal Ant Design mock for Jest / jsdom tests.
 * Renders just enough structure for @testing-library queries to work without
 * triggering jsdom-unsupported browser APIs (matchMedia, getComputedStyle, etc.)
 */
import React from 'react'

// Table renders each row's column values as plain <td> elements
export function Table({ dataSource = [], columns = [], rowKey }: any) {
  return (
    <table>
      <thead>
        <tr>
          {columns.map((col: any) => (
            <th key={col.key}>{col.title}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dataSource.map((row: any, ri: number) => (
          <tr key={row[rowKey] ?? ri}>
            {columns.map((col: any) => {
              const val = col.dataIndex ? row[col.dataIndex] : undefined
              const rendered = col.render ? col.render(val, row) : val
              return <td key={col.key}>{rendered}</td>
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// Tag renders a simple <span>
export function Tag({ children }: any) {
  return <span>{children}</span>
}

// Typography.Title renders an <h3>, Typography.Text renders a <span>
export const Typography = {
  Title: ({ children, level }: any) => React.createElement(`h${level ?? 1}`, {}, children),
  Text: ({ children }: any) => <span>{children}</span>,
}

// Card renders a <div> with its title and children
export function Card({ title, children }: any) {
  return (
    <div>
      {title && <div>{title}</div>}
      {children}
    </div>
  )
}

// Alert renders a <div> with title/message and description
export function Alert({ title, message, description }: any) {
  return (
    <div>
      {(title || message) && <div>{title ?? message}</div>}
      {description && <div>{description}</div>}
    </div>
  )
}

export default { Table, Tag, Typography, Card, Alert }
