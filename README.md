# Check System

App de 99 Jiu-Jitsu México. Incluye cronómetro de rounds, marcador de lucha, modo pantalla para las teles, check-in de asistencia con fotos y cobro de mensualidades.

- **Publicación:** GitHub Pages, en `https://elsarabia.github.io/Checksystem99/`.
- **Datos y cuentas:** el proyecto **Check System** de Supabase (organización Unicorn).

## Puesta en marcha (una sola vez)

1. **Activar GitHub Pages.** En el repo ve a Settings → Pages. En Source elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`.
2. **Configurar las direcciones en Supabase.** En el proyecto Check System ve a Authentication → URL Configuration:
   - **Site URL:** `https://elsarabia.github.io/Checksystem99/`
   - **Redirect URLs:** agrega `https://elsarabia.github.io/Checksystem99/**`

   Así los correos de confirmación y de "olvidé mi contraseña" regresan a la app.
3. **Opcional: entrar sin confirmar correo.** En Authentication → Sign In / Providers → Email, apaga **Confirm email**. Las cuentas nuevas igual quedan sin acceso hasta que el administrador las apruebe.
4. **Crear tu cuenta.** Abre la app y toca **Crear cuenta**. La primera cuenta que se registra queda como **administrador**.

## Instalar la app

- **Android:** abre la dirección en Chrome, menú ⋮ → **Instalar app**.
- **iPhone / iPad:** abre la dirección en **Safari**, botón Compartir → **Agregar a inicio**.
- **Computadora:** abre la dirección en Chrome o Edge y toca el ícono de instalar en la barra de direcciones.

## Cuentas del equipo

Quien vaya a usar la app la abre y toca **Crear cuenta**. Tú le das acceso desde el ícono de persona → **Equipo y cuentas**. Cuando hay cuentas esperando, ese ícono muestra un punto dorado.

| Tipo | Qué puede hacer |
|---|---|
| Administrador | Todo, más aprobar cuentas y descargar respaldos |
| Profe | Asistencia, cobros, alumnos, cronómetro y marcador |
| Pantalla | Solo ver. Úsala en las teles del gym (ícono de tele) |

Los permisos los aplica la base de datos misma, no solo la app.

## Respaldos

- Desde la app: ícono de persona → **Descargar respaldo**. Te baja un archivo con todos los datos.
- El plan gratis de Supabase **pausa el proyecto si pasa una semana sin uso**. Con el uso diario del gym no pasa. Si llegara a pausarse, se reactiva desde supabase.com sin perder datos.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La app |
| `adapter.js` | La conexión con Supabase: inicio de sesión, datos, tiempo real y equipo |
| `vendor/supabase.js` | La librería oficial de Supabase (versión 2.118.0) |
| `sw.js` y `manifest.webmanifest` | Lo que la hace instalable y le permite abrir sin internet |
| `supabase/esquema.sql` | Tablas, roles y permisos de la base de datos, por si hay que recrearla |

La llave que aparece en `adapter.js` es la **pública** de Supabase. Está hecha para ir en la app y no da acceso a nada sin una cuenta aprobada.
