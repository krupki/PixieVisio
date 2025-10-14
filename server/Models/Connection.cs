using System;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace PixieVisio.Server.Models
{
    [Table("connections")]
    public class Connection
    {
        [Key]
        public string Id { get; set; } = Guid.NewGuid().ToString();

        public string ModelId { get; set; } = "default";

        [Required]
        public string FromNodeId { get; set; } = string.Empty;

        [Required]
        public string ToNodeId { get; set; } = string.Empty;

        public string Style { get; set; } = "solid";
        public string Color { get; set; } = "#333333";
        public int Width { get; set; } = 3;
        public string Label { get; set; } = string.Empty;
    }
}